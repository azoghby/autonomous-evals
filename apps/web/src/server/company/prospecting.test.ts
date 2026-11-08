import { describe, expect, it, vi } from "vitest";

vi.mock("./store", () => ({ drizzleRuntimeDeps: () => { throw new Error("db not available in tests"); } }));
vi.mock("./mailer", () => ({ sendCompanyEmail: vi.fn() }));

import type { generateStructured } from "@ae/core/ai/gateway";
import type { LeadCandidate } from "@ae/core/company/research";
import { runProspectingAgent, type ProspectingStore } from "./prospecting";
import type { ContactCandidate, ContactFinder } from "./contacts";
import { memoryRuntime } from "./runtime.testing";
import { sendCompanyEmail } from "./mailer";
import type { WebSearch } from "./web-search";

const env = { COMPANY_AGENTS_DAILY_BUDGET_USD: "5" };
const now = new Date("2026-11-07T11:30:00Z");

const webSearch: WebSearch = async (_q, ctx) => {
  await ctx.recordCost({ source: "ai_gateway", microUsd: 6_000, meta: {} });
  return { text: "t", sources: [{ url: "https://a.ai/p" }, { url: "https://b.io/p" }, { url: "https://c.com/p" }], microUsd: 6_000 };
};

const mk = (domain: string, fit: number, over: Partial<LeadCandidate> = {}): LeadCandidate => ({
  company: domain, domain, segment: "support", agentDescription: "An agent that resolves tickets and issues refunds.",
  evidence: [{ url: `https://${domain.split(".")[0]}.${domain.split(".")[1]}/p` }], fitScore: fit, fitReason: "r", recommendedPlan: "pro", ...over,
});

function fakeStore(known: string[] = [], suppressed: string[] = []) {
  const inserted: Array<{ id: string; domain: string; fitScore: number }> = [];
  const contacts = new Map<string, unknown>();
  const statuses = new Map<string, string>();
  const store: ProspectingStore = {
    existingDomains: async (ds) => new Set(ds.filter((d) => known.includes(d))),
    insertLeads: async (ls) => { for (const l of ls) inserted.push({ id: `id-${l.domain}`, domain: l.domain, fitScore: l.fitScore }); return ls.map((l) => ({ id: `id-${l.domain}`, domain: l.domain, fitScore: l.fitScore })); },
    isSuppressed: async (e) => suppressed.includes(e),
    setContact: async (id, c) => { contacts.set(id, c); },
    setStatus: async (id, s) => { statuses.set(id, s); },
    seedCompanies: async () => ["SeedCo"],
  };
  return { store, inserted, contacts, statuses };
}

const gen = (leads: LeadCandidate[]) => vi.fn(async () => ({ object: { leads }, text: "", usage: {} })) as unknown as typeof generateStructured;
const cand = (email: string, over: Partial<ContactCandidate> = {}): ContactCandidate => ({
  email, name: null, role: null, sourceUrl: "https://a.ai/contact", sourceUrls: ["https://a.ai/contact"], confidence: 90, isGeneric: true, verification: "valid", ...over,
});
const finder = (byDomain: Record<string, ContactCandidate[]>): ContactFinder & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, find: async (d) => { calls.push(d); return { candidates: byDomain[d] ?? [], microUsd: 24_500 }; } };
};

describe("runProspectingAgent", () => {
  it("grounds, dedupes against the DB, caps at 15, finds contacts, never sends", async () => {
    const m = memoryRuntime();
    const { store, inserted, contacts } = fakeStore(["known.com"]);
    const f = finder({ "a.ai": [cand("gmail@gmail.com"), cand("hello@a.ai")] });
    const leads = [
      mk("a.ai", 90), mk("a.ai", 50), mk("b.io", 80, { evidence: [{ url: "https://invented.com" }] }), mk("known.com", 85, { evidence: [{ url: "https://c.com/p" }] }),
      mk("c.com", 62), mk("github.com", 99, { evidence: [{ url: "https://b.io/p" }] }),
    ];
    const r = await runProspectingAgent({ trigger: "manual", now, env }, { runtime: m.deps, webSearch, generate: gen(leads), store, contactFinder: f });

    expect(r.status).toBe("ok");
    expect(inserted.map((i) => i.domain).sort()).toEqual(["a.ai", "c.com"]);
    expect(contacts.get("id-a.ai")).toMatchObject({ contactEmail: "hello@a.ai", contactSource: "https://a.ai/contact" });
    expect(f.calls).toEqual(["a.ai", "c.com"]);
    expect(m.activities[0].counts).toMatchObject({ searches: 6, candidates: 3, newLeads: 2, duplicates: 1, contactsFound: 1 });
    expect(m.costs.some((c) => c.source === "company_tool" && c.microUsd === 24_500)).toBe(true);
    expect(m.activities[0].publicSummary).not.toMatch(/a\.ai|hello@/);
    expect(sendCompanyEmail).not.toHaveBeenCalled();
  });

  it("inserts at most 15 new leads per run", async () => {
    const m = memoryRuntime();
    const { store, inserted } = fakeStore();
    const doms = Array.from({ length: 20 }, (_, i) => `co${i}.com`);
    const leads = doms.map((d, i) => mk(d, 30 + i, { evidence: [{ url: "https://c.com/p" }] }));
    await runProspectingAgent({ trigger: "cron", now, env }, { runtime: m.deps, webSearch, generate: gen(leads), store, contactFinder: finder({}) });
    expect(inserted).toHaveLength(15);
    expect(inserted.some((i) => i.domain === "co19.com")).toBe(true);
  });

  it("looks up contacts only for fit >= 60, at most 5", async () => {
    const m = memoryRuntime();
    const { store } = fakeStore();
    const f = finder({});
    const leads = [...Array.from({ length: 8 }, (_, i) => mk(`hi${i}.com`, 80 + i, { evidence: [{ url: "https://c.com/p" }] })), mk("lo.com", 40, { evidence: [{ url: "https://c.com/p" }] })];
    await runProspectingAgent({ trigger: "cron", now, env }, { runtime: m.deps, webSearch, generate: gen(leads), store, contactFinder: f });
    expect(f.calls).toHaveLength(5);
    expect(f.calls).not.toContain("lo.com");
  });

  it("marks a lead suppressed and stores no contact when the email is on the suppression list", async () => {
    const m = memoryRuntime();
    const { store, contacts, statuses } = fakeStore([], ["hello@a.ai"]);
    await runProspectingAgent({ trigger: "cron", now, env }, {
      runtime: m.deps, webSearch, generate: gen([mk("a.ai", 90)]), store, contactFinder: finder({ "a.ai": [cand("hello@a.ai")] }),
    });
    expect(statuses.get("id-a.ai")).toBe("suppressed");
    expect(contacts.size).toBe(0);
    expect(m.activities[0].counts?.contactsFound).toBe(0);
  });

  it("keeps leads when Monid is not configured or errors", async () => {
    const m = memoryRuntime();
    const { store, inserted } = fakeStore();
    const failing: ContactFinder = { find: async () => { throw new Error("boom"); } };
    const r = await runProspectingAgent({ trigger: "cron", now, env }, { runtime: m.deps, webSearch, generate: gen([mk("a.ai", 90)]), store, contactFinder: failing });
    expect(r.status).toBe("ok");
    expect(inserted).toHaveLength(1);
    expect(m.activities[0].counts?.contactsFound).toBe(0);
  });

  it("skips when no search succeeds", async () => {
    const m = memoryRuntime();
    const { store, inserted } = fakeStore();
    const r = await runProspectingAgent({ trigger: "cron", now, env }, {
      runtime: m.deps, webSearch: async () => { throw new Error("down"); }, generate: gen([mk("a.ai", 90)]), store, contactFinder: finder({}),
    });
    expect(r.status).toBe("skipped");
    expect(inserted).toHaveLength(0);
  });
});
