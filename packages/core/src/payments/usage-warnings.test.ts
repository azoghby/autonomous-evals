import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client", () => ({ db: () => ({}), schema: {} }));
vi.mock("../auth/tokens", () => ({ isOperator: () => false }));

import {
  crossedThreshold, sendUsageWarnings, usageWarningEmail, type UsageWarningClaim, type UsageWarningDeps, type WarnableCustomer,
} from "./usage-warnings";

const NOW = new Date("2026-11-08T10:00:00Z");
const cust = (over: Partial<WarnableCustomer> = {}): WarnableCustomer => ({ id: "c1", email: "o@x.co", name: "Ola", plan: "pro", planStatus: "active", ...over });

function makeDeps(rows: Array<{ customer: WarnableCustomer; trialsUsed: number }>, opts: { failSend?: boolean; canSend?: boolean } = {}) {
  const markers = new Map<string, UsageWarningClaim>();
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const key = (c: string, p: Date, t: number) => `${c}|${p.toISOString()}|${t}`;
  const deps: UsageWarningDeps = {
    listActiveCustomers: async () => rows,
    claim: async (r) => { const k = key(r.customerId, r.periodStart, r.threshold); if (markers.has(k)) return false; markers.set(k, r); return true; },
    release: async (c, p, t) => { markers.delete(key(c, p, t)); },
    send: async (m) => { if (opts.failSend) throw new Error("smtp down"); sent.push(m); },
    canSend: () => opts.canSend ?? true,
  };
  return { deps, markers, sent };
}
const run = (deps: UsageWarningDeps) => sendUsageWarnings({ now: NOW, origin: "https://app.test" }, deps);

describe("crossedThreshold", () => {
  it("returns the highest threshold crossed", () => {
    expect(crossedThreshold(1999, 2500)).toBeNull();
    expect(crossedThreshold(2000, 2500)).toBe(80);
    expect(crossedThreshold(2499, 2500)).toBe(80);
    expect(crossedThreshold(2500, 2500)).toBe(100);
    expect(crossedThreshold(9000, 2500)).toBe(100);
    expect(crossedThreshold(5, null)).toBeNull();
  });
});

describe("sendUsageWarnings", () => {
  it("sends an 80% warning to the owner's own address once", async () => {
    const { deps, sent } = makeDeps([{ customer: cust(), trialsUsed: 2100 }]);
    const first = await run(deps);
    const second = await run(deps);
    expect(first).toMatchObject({ period: "2026-11", sent: 1, failed: 0 });
    expect(second).toMatchObject({ sent: 0, skipped: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "o@x.co" });
    expect(sent[0]!.text).toContain("https://app.test/settings/billing");
  });
  it("sends 100% separately after 80% and never repeats either", async () => {
    const rows = [{ customer: cust(), trialsUsed: 2100 }];
    const { deps, sent } = makeDeps(rows);
    await run(deps);
    rows[0]!.trialsUsed = 2600;
    await run(deps);
    await run(deps);
    expect(sent.map((m) => m.subject)).toEqual([expect.stringContaining("80%"), expect.stringContaining("all included trials")]);
  });
  it("jumping straight to 100% sends one email and marks 80% skipped so it never fires late", async () => {
    const { deps, markers, sent } = makeDeps([{ customer: cust(), trialsUsed: 2600 }]);
    await run(deps);
    expect(sent).toHaveLength(1);
    expect([...markers.values()].map((m) => `${m.threshold}:${m.status}`).sort()).toEqual(["100:sent", "80:skipped"]);
  });
  it("does not warn below 80% or on plans without an allowance", async () => {
    const { deps, sent } = makeDeps([
      { customer: cust({ id: "a" }), trialsUsed: 100 },
      { customer: cust({ id: "b", plan: "enterprise" }), trialsUsed: 99999 },
    ]);
    expect(await run(deps)).toMatchObject({ sent: 0, skipped: 2 });
    expect(sent).toHaveLength(0);
  });
  it("uses the free plan allowance for developer and says runs pause", async () => {
    const { deps, sent } = makeDeps([{ customer: cust({ plan: "developer", planStatus: null }), trialsUsed: 50 }]);
    await run(deps);
    expect(sent[0]!.text).toContain("paused");
  });
  it("releases the marker when the send fails so the next run retries", async () => {
    const failing = makeDeps([{ customer: cust(), trialsUsed: 2100 }], { failSend: true });
    expect(await run(failing.deps)).toMatchObject({ sent: 0, failed: 1 });
    expect([...failing.markers.values()].filter((m) => m.status === "sent")).toHaveLength(0);
  });
  it("does nothing when no email transport is configured", async () => {
    const { deps, markers } = makeDeps([{ customer: cust(), trialsUsed: 2600 }], { canSend: false });
    expect(await run(deps)).toMatchObject({ considered: 0, sent: 0 });
    expect(markers.size).toBe(0);
  });
});

describe("usageWarningEmail", () => {
  it("states overage for paid plans at 100%", () => {
    const m = usageWarningEmail({ name: null, plan: "pro", threshold: 100, used: 2600, included: 2500, origin: "https://a", resetsOn: "2026-12-01" });
    expect(m.text).toContain("$0.20");
    expect(m.text.startsWith("Hi,")).toBe(true);
  });
});
