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
  it("data/public-agents.json is valid, key-free; active entries are authorized local real agents, old Acme baselines are deactivated", () => {
    const raw = JSON.parse(readFileSync(new URL("../../../../data/public-agents.json", import.meta.url), "utf8")) as { agents: unknown[]; todo: string[] };
    expect(raw.agents.length).toBe(18);
    expect(raw.todo.length).toBeGreaterThan(0);
    const parsed = raw.agents.map((a) => PublicAgentInput.parse(a));
    const active = parsed.filter((p) => p.active);
    expect(active).toHaveLength(7);
    for (const p of active) {
      expect(() => assertAuthorizedToTest(p)).not.toThrow();
      expect(p.kind).toBe("local_reference");
      expect(p.authEnvVar ?? null).toBeNull();
    }
    const inactive = parsed.filter((x) => !x.active);
    for (const p of inactive.filter((x) => x.kind === "reference")) expect(p.slug).toMatch(/^acme-/);
    expect(inactive.filter((x) => x.kind === "reference")).toHaveLength(10);
    // Paused until re-run under the provider-refusal rule (see todo).
    expect(inactive.filter((x) => x.kind === "local_reference").map((x) => x.slug)).toEqual(["adk-customer-service--claude-opus-5-5"]);
    expect(JSON.stringify(raw)).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });

  describe("local_reference", () => {
    const local = { ...base, slug: "x-local", kind: "local_reference", endpointUrl: "http://127.0.0.1:8765/v1/chat/completions" };
    it("accepts only the exact loopback shim URL, with no key", () => {
      expect(PublicAgentInput.safeParse(local).success).toBe(true);
      for (const u of ["http://localhost:8765/v1/chat/completions", "http://127.0.0.1/v1/chat/completions", "http://127.0.0.1:8765/other", "http://10.0.0.5:8765/v1/chat/completions", "https://127.0.0.1:8765/v1/chat/completions", "http://127.0.0.1:8765@evil.com/v1/chat/completions"]) {
        expect(PublicAgentInput.safeParse({ ...local, endpointUrl: u }).success, u).toBe(false);
      }
      expect(PublicAgentInput.safeParse({ ...local, authEnvVar: "MY_KEY" }).success).toBe(false);
    });
    it("http loopback is still rejected for non-local kinds", () => {
      expect(PublicAgentInput.safeParse({ ...base, endpointUrl: "http://127.0.0.1:8765/v1/chat/completions" }).success).toBe(false);
      expect(PublicAgentInput.safeParse({ ...local, kind: "third_party" }).success).toBe(false);
    });
  });
});
