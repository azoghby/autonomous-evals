import { describe, expect, it, vi } from "vitest";
import { ContactFinderError, createMonidContactFinder, parseHunterOutput, pickContact, type ContactCandidate } from "./contacts";

const hunter = (emails: unknown[]) => ({ data: { domain: "acme.ai", emails } });
const email = (value: string, over: Record<string, unknown> = {}) => ({
  value, type: "generic", confidence: 90, sources: [{ uri: "https://acme.ai/contact", still_on_page: true }],
  first_name: null, last_name: null, position: null, verification: { status: "valid" }, ...over,
});

describe("parseHunterOutput / pickContact", () => {
  it("parses candidates with the live public source", () => {
    const c = parseHunterOutput(hunter([email("Hello@acme.ai", { sources: [{ uri: "https://old.com", still_on_page: false }, { uri: "https://acme.ai/x", still_on_page: true }] })]));
    expect(c[0]).toMatchObject({ email: "hello@acme.ai", sourceUrl: "https://acme.ai/x", isGeneric: true });
    expect(parseHunterOutput(null)).toEqual([]);
  });
  it("never guesses: a candidate without a public source is dropped", () => {
    const c = parseHunterOutput(hunter([email("hello@acme.ai", { sources: [] })]));
    expect(pickContact(c, "acme.ai")).toBeNull();
  });
  it("rejects an address seen only on one third-party page and placeholder names", () => {
    const third = email("hello@acme.ai", { sources: [{ uri: "https://docs.other.com/example", still_on_page: true }] });
    expect(pickContact(parseHunterOutput(hunter([third])), "acme.ai")).toBeNull();
    const many = email("hello@acme.ai", { sources: ["a", "b", "c"].map((h) => ({ uri: `https://${h}.com/p`, still_on_page: true })) });
    expect(pickContact(parseHunterOutput(hunter([many])), "acme.ai")?.email).toBe("hello@acme.ai");
    expect(pickContact(parseHunterOutput(hunter([email("jane@acme.ai")])), "acme.ai")).toBeNull();
  });
  it("prefers role addresses and rejects free mail / other domains / invalid verification", () => {
    const c: ContactCandidate[] = parseHunterOutput(hunter([
      email("alex@acme.ai", { type: "personal", first_name: "Alex", last_name: "Doe", position: "Engineer", confidence: 95 }),
      email("founders@acme.ai", { confidence: 70 }),
      email("me@gmail.com"), email("x@other.com"), email("bad@acme.ai", { verification: { status: "invalid" }, confidence: 100 }),
    ]));
    expect(pickContact(c, "acme.ai")).toMatchObject({ email: "founders@acme.ai", sourceUrl: "https://acme.ai/contact" });
  });
  it("takes a founder's listed work email when no role address exists", () => {
    const c = parseHunterOutput(hunter([email("alex@acme.ai", { type: "personal", first_name: "Alex", last_name: "Doe", position: "Co-founder & CEO" })]));
    expect(pickContact(c, "acme.ai")).toMatchObject({ email: "alex@acme.ai", name: "Alex Doe", role: "Co-founder & CEO" });
  });
});

describe("createMonidContactFinder", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("throws not_configured without a key and makes no request", async () => {
    const fetchImpl = vi.fn();
    const f = createMonidContactFinder({ apiKey: undefined, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(f.find("acme.ai")).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the run, polls to completion, and uses the reported cost", async () => {
    const responses = [
      json({ runId: "r1", status: "RUNNING" }),
      json({ runId: "r1", status: "COMPLETED", output: hunter([email("hello@acme.ai")]), billing: { reportedCost: { value: 24_500, unit: "MICRO_DOLLAR" } } }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const f = createMonidContactFinder({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });
    const res = await f.find("acme.ai");
    expect(res.microUsd).toBe(24_500);
    expect(res.candidates[0].email).toBe("hello@acme.ai");
    const first = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(first[0]).toBe("https://api.monid.ai/v1/run");
    expect(JSON.parse(String(first[1].body))).toMatchObject({ provider: "hunterio", endpoint: "/domain-search", input: { body: { domain: "acme.ai" } } });
    expect((first[1].headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("maps blocked and failed runs to typed errors", async () => {
    const mk = (status: string) => createMonidContactFinder({ apiKey: "k", fetchImpl: (async () => json({ runId: "r", status })) as unknown as typeof fetch, sleep: async () => {} });
    await expect(mk("BLOCKED").find("a.ai")).rejects.toBeInstanceOf(ContactFinderError);
    await expect(mk("BLOCKED").find("a.ai")).rejects.toMatchObject({ code: "blocked" });
    await expect(mk("FAILED").find("a.ai")).rejects.toMatchObject({ code: "request_failed" });
  });
});
