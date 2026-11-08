import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PublicAgentInput, UnauthorizedAgentError, assertAuthorizedToTest } from "./leaderboard-agents";

const ok = { slug: "acme-x", termsUrl: "https://example.com/terms", authorizedNote: "Written permission from vendor, 2026-11-07", active: true };

describe("assertAuthorizedToTest", () => {
  it("accepts an agent with terms and an authorization note", () => { expect(() => assertAuthorizedToTest(ok)).not.toThrow(); });
  it.each([
    ["missing termsUrl", { ...ok, termsUrl: null }],
    ["empty termsUrl", { ...ok, termsUrl: "" }],
    ["TODO termsUrl", { ...ok, termsUrl: "TODO" }],
    ["http termsUrl", { ...ok, termsUrl: "http://example.com/terms" }],
    ["missing note", { ...ok, authorizedNote: undefined }],
    ["blank note", { ...ok, authorizedNote: "   " }],
    ["placeholder note", { ...ok, authorizedNote: "TBD" }],
    ["inactive", { ...ok, active: false }],
    ["key pasted as authEnvVar", { ...ok, authEnvVar: "sk-live-abcdefghijklmnopqrstuvwxyz0123456789" }],
  ])("refuses: %s", (_n, a) => { expect(() => assertAuthorizedToTest(a)).toThrow(UnauthorizedAgentError); });
});

describe("PublicAgentInput", () => {
  const base = { slug: "acme-x", name: "n", vendor: "v", kind: "reference", endpointUrl: "https://api.example.com/v1/chat/completions", model: "m" };
  it("rejects non-https endpoints and secret-looking env var names", () => {
    expect(PublicAgentInput.safeParse({ ...base, endpointUrl: "http://x.com/v1" }).success).toBe(false);
    expect(PublicAgentInput.safeParse({ ...base, authEnvVar: "sk-abc" }).success).toBe(false);
    expect(PublicAgentInput.safeParse({ ...base, authEnvVar: "MY_KEY" }).success).toBe(true);
  });
  it("data/public-agents.json is valid, authorized, key-free and has no third-party entries without a terms record", () => {
    const raw = JSON.parse(readFileSync(new URL("../../../../data/public-agents.json", import.meta.url), "utf8")) as { agents: unknown[]; todo: string[] };
    expect(raw.agents.length).toBe(5);
    expect(raw.todo.length).toBeGreaterThan(0);
    for (const a of raw.agents) {
      const p = PublicAgentInput.parse(a);
      expect(() => assertAuthorizedToTest(p)).not.toThrow();
      expect(p.kind).toBe("reference");
    }
    expect(JSON.stringify(raw)).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });
});
