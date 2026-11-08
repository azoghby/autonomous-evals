import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@ae/core/db/client", () => ({ db: () => { throw new Error("db must not be touched"); } }));
vi.mock("@ae/core/db/schema", () => ({ salesLeads: {} }));
vi.mock("./operator-alerts", () => ({ alertOperators: vi.fn(), redactAlertText: (s: string) => s }));
const rateLimit = vi.fn();
vi.mock("./rate-limit", () => ({ rateLimit: (...a: unknown[]) => rateLimit(...a) }));

import { hashIp, parseSalesLead, submitSalesLead } from "./sales-leads";

const valid = {
  name: "  Ada Lovelace ",
  workEmail: "Ada@Example.com",
  company: "Analytical Co",
  agentDescription: "A support agent with Zendesk and Stripe tools.",
  volume: "1k-10k",
};

describe("parseSalesLead", () => {
  it("accepts a valid lead and normalizes whitespace and email case", () => {
    const r = parseSalesLead(valid);
    expect(r.kind).toBe("lead");
    if (r.kind === "lead") {
      expect(r.lead.name).toBe("Ada Lovelace");
      expect(r.lead.workEmail).toBe("ada@example.com");
      expect("website" in r.lead).toBe(false);
    }
  });

  it("treats a filled honeypot as a bot, even with otherwise invalid input", () => {
    expect(parseSalesLead({ ...valid, website: "http://spam" }).kind).toBe("honeypot");
    expect(parseSalesLead({ website: "x" }).kind).toBe("honeypot");
  });

  it("accepts an empty honeypot", () => {
    expect(parseSalesLead({ ...valid, website: "" }).kind).toBe("lead");
  });

  it("returns field errors for bad input", () => {
    const r = parseSalesLead({ ...valid, workEmail: "nope", agentDescription: "short", volume: "huge", name: " " });
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(Object.keys(r.fieldErrors).sort()).toEqual(["agentDescription", "name", "volume", "workEmail"]);
  });

  it("enforces max lengths and rejects non-objects", () => {
    expect(parseSalesLead({ ...valid, agentDescription: "x".repeat(4001) }).kind).toBe("invalid");
    expect(parseSalesLead(null).kind).toBe("invalid");
  });
});

describe("submitSalesLead", () => {
  beforeEach(() => rateLimit.mockReset());

  it("pretends success for the honeypot without rate limiting or storing", async () => {
    expect(await submitSalesLead({ ...valid, website: "bot" }, "1.2.3.4")).toEqual({ ok: true });
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("returns 400 field errors before touching the db", async () => {
    const r = await submitSalesLead({ ...valid, workEmail: "bad" }, "1.2.3.4");
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("returns 429 keyed on the ip hash, never the raw ip", async () => {
    rateLimit.mockResolvedValue({ ok: false, retryAfter: 42 });
    const r = await submitSalesLead(valid, "1.2.3.4");
    expect(r).toEqual({ ok: false, status: 429, retryAfter: 42 });
    expect(rateLimit).toHaveBeenCalledWith(`contact-sales:${hashIp("1.2.3.4")}`, 5, 3600);
    expect(String(rateLimit.mock.calls[0][0])).not.toContain("1.2.3.4");
  });
});

describe("hashIp", () => {
  it("is a stable sha256 hex digest", () => {
    expect(hashIp("1.2.3.4")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIp("1.2.3.4")).toBe(hashIp("1.2.3.4"));
  });
});
