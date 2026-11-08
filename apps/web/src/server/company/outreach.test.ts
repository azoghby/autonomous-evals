import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./store", () => ({ drizzleRuntimeDeps: () => { throw new Error("db not available in tests"); } }));
vi.mock("./outreach-store", () => ({ drizzleOutreachStore: () => { throw new Error("db not available in tests"); } }));
vi.mock("@ae/core/auth/email", () => ({ sendEmail: () => { throw new Error("sendEmail must never be called by the outreach agent"); } }));

import { recordProspectReply, runOutreachAgent } from "./outreach";
import type { FollowUpLead, OutreachLead, OutreachStore } from "./outreach-store";
import { memoryRuntime } from "./runtime.testing";

const NOW = new Date("2026-03-10T12:00:00Z");
const lead = (i: number, over: Partial<OutreachLead> = {}): OutreachLead => ({
  id: `lead-${i}`, domain: `co${i}.ai`, company: `Co${i}`, segment: "support", agentDescription: "refund agent",
  evidence: [{ url: "https://co.ai/p" }], fitScore: 90 - i, recommendedPlan: "pro",
  contactEmail: `x${i}@co${i}.ai`, contactName: "Sam", contactRole: "CTO", ...over,
});

interface FakeOpts { drafted?: number; leads?: OutreachLead[]; followUps?: FollowUpLead[]; suppressed?: string[]; recent?: string[] }
function fakeStore(o: FakeOpts = {}) {
  const drafts: Array<{ toEmail: string; subject: string; body: string; kind: string; status: "pending" }> = [];
  const leadPatches: Array<{ id: string; status: string; outreachDraftId?: string }> = [];
  const suppressed = new Set(o.suppressed ?? []);
  const rejected: string[] = [];
  const store: OutreachStore = {
    countSdrDraftsSince: async () => o.drafted ?? 0,
    newLeads: async () => o.leads ?? [],
    followUpLeads: async () => o.followUps ?? [],
    isSuppressed: async (e) => suppressed.has(e.toLowerCase()),
    recentDraftExists: async (e) => (o.recent ?? []).includes(e),
    insertDraft: async (r) => { drafts.push({ ...r, status: "pending" }); return `draft-${drafts.length}`; },
    setLead: async (id, patch) => { leadPatches.push({ id, ...patch }); },
    matchLeadByEmail: async (e) => ((o.leads ?? []).find((l) => l.contactEmail === e) ? { id: "m" } : null),
    suppress: async (e) => { suppressed.add(e); },
    rejectPendingDrafts: async (e) => { rejected.push(e); },
    appUrl: () => "https://app.example.com",
    companyAddress: () => "1 Main St",
    unsubscribeUrl: (e) => `https://app.example.com/u?e=${e}`,
  };
  return { store, drafts, leadPatches, suppressed, rejected };
}

const goodEmail = { subject: "Staging for your refund agent", body: "Hi Sam, we catch skipped verification in refund agents before launch. Want a free Developer sandbox?" };

async function run(fake: ReturnType<typeof fakeStore>, generate = vi.fn(async () => goodEmail), env: Record<string, string> = {}) {
  const m = memoryRuntime();
  const result = await runOutreachAgent({ trigger: "manual", now: NOW, ignoreToggle: true, env: { COMPANY_OUTREACH_DAILY_CAP: "20", ...env }, deps: m.deps }, { store: fake.store, generate });
  return { result, m, generate };
}
const counts = (r: Awaited<ReturnType<typeof run>>) => (r.result.status === "ok" ? r.result.outcome?.counts : undefined) as Record<string, number>;

describe("runOutreachAgent", () => {
  it("creates pending drafts with footer, marks leads drafted, never sends", async () => {
    const fake = fakeStore({ leads: [lead(1), lead(2)] });
    const r = await run(fake);
    expect(fake.drafts).toHaveLength(2);
    for (const d of fake.drafts) {
      expect(d.status).toBe("pending");
      expect(d.kind).toBe("sdr_first_touch");
      expect(d.body).toContain("approved by a human founder");
      expect(d.body).toContain("1 Main St");
    }
    expect(fake.leadPatches).toEqual([
      { id: "lead-1", status: "drafted", outreachDraftId: "draft-1" },
      { id: "lead-2", status: "drafted", outreachDraftId: "draft-2" },
    ]);
    expect(counts(r)).toMatchObject({ drafted: 2, capRemaining: 18 });
    const pub = r.result.status === "ok" ? r.result.outcome?.publicSummary : "";
    expect(pub).toContain("Nothing sent");
    expect(pub).not.toMatch(/Co1|co1\.ai|@/);
  });

  it("limits a run to 10 drafts and respects the daily cap", async () => {
    const many = Array.from({ length: 30 }, (_, i) => lead(i));
    const a = fakeStore({ leads: many });
    await run(a);
    expect(a.drafts).toHaveLength(10);
    const b = fakeStore({ leads: many, drafted: 17 });
    await run(b);
    expect(b.drafts).toHaveLength(3);
    const c = fakeStore({ leads: many, drafted: 20 });
    const rc = await run(c);
    expect(c.drafts).toHaveLength(0);
    expect(rc.generate).not.toHaveBeenCalled();
  });

  it("skips and suppresses leads on the suppression list", async () => {
    const fake = fakeStore({ leads: [lead(1), lead(2)], suppressed: ["x1@co1.ai"] });
    const r = await run(fake);
    expect(fake.drafts).toHaveLength(1);
    expect(fake.leadPatches[0]).toEqual({ id: "lead-1", status: "suppressed" });
    expect(counts(r)).toMatchObject({ skippedSuppressed: 1, drafted: 1 });
  });

  it("dedupes against recent drafts and same-domain leads in one run", async () => {
    const fake = fakeStore({ leads: [lead(1), lead(2), lead(3, { contactEmail: "other@co1.ai", domain: "co1.ai" })], recent: ["x2@co2.ai"] });
    const r = await run(fake);
    expect(fake.drafts.map((d) => d.toEmail)).toEqual(["x1@co1.ai"]);
    expect(counts(r)).toMatchObject({ skippedDuplicate: 2, drafted: 1 });
  });

  it("drops drafts the validator rejects", async () => {
    const fake = fakeStore({ leads: [lead(1)] });
    const generate = vi.fn(async () => ({ subject: "Hi", body: "We tested your agent and it failed 40% of cases." }));
    const r = await run(fake, generate);
    expect(fake.drafts).toHaveLength(0);
    expect(counts(r)).toMatchObject({ rejectedByValidator: 1, drafted: 0 });
  });

  it("survives a generator failure", async () => {
    const fake = fakeStore({ leads: [lead(1), lead(2)] });
    const generate = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(goodEmail);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await run(fake, generate);
    spy.mockRestore();
    expect(fake.drafts).toHaveLength(1);
  });

  it("drafts follow-ups only when due, as pending sdr_follow_up, counted against the cap", async () => {
    const due: FollowUpLead = { ...lead(1), lastDraftAt: new Date("2026-03-01T00:00:00Z"), hasPendingDraft: false };
    const recent: FollowUpLead = { ...lead(2), lastDraftAt: new Date("2026-03-09T00:00:00Z"), hasPendingDraft: false };
    const pending: FollowUpLead = { ...lead(3), lastDraftAt: new Date("2026-03-01T00:00:00Z"), hasPendingDraft: true };
    const fake = fakeStore({ followUps: [due, recent, pending], leads: [lead(9)], drafted: 19 });
    const r = await run(fake);
    expect(fake.drafts.map((d) => [d.kind, d.status])).toEqual([["sdr_follow_up", "pending"]]);
    expect(counts(r)).toMatchObject({ followUps: 1, drafted: 0, capRemaining: 0 });
    expect(fake.leadPatches.find((p) => p.id === due.id)).toBeUndefined();
  });

  it("does nothing when the toggle is off", async () => {
    const fake = fakeStore({ leads: [lead(1)] });
    const m = memoryRuntime();
    m.toggles.set("outreach", false);
    const res = await runOutreachAgent({ trigger: "cron", deps: m.deps, env: {} }, { store: fake.store, generate: vi.fn() });
    expect(res).toMatchObject({ status: "skipped", reason: "disabled" });
    expect(fake.drafts).toHaveLength(0);
  });
});

describe("recordProspectReply", () => {
  it("returns unmatched for unknown senders", async () => {
    const fake = fakeStore();
    expect(await recordProspectReply("nobody@x.com", "hi", fake.store)).toEqual({ matched: false, optedOut: false });
  });

  it("marks a normal reply as replied (case-insensitive match)", async () => {
    const fake = fakeStore({ leads: [lead(1)] });
    expect(await recordProspectReply("X1@co1.ai", "Interested, tell me more", fake.store)).toEqual({ matched: true, optedOut: false });
    expect(fake.leadPatches).toEqual([{ id: "m", status: "replied" }]);
  });

  it("suppresses and rejects pending drafts on opt-out", async () => {
    const fake = fakeStore({ leads: [lead(1)] });
    expect(await recordProspectReply("x1@co1.ai", "No thanks, please remove me", fake.store)).toEqual({ matched: true, optedOut: true });
    expect(fake.suppressed.has("x1@co1.ai")).toBe(true);
    expect(fake.leadPatches).toEqual([{ id: "m", status: "suppressed" }]);
    expect(fake.rejected).toEqual(["x1@co1.ai"]);
  });
});
