import { describe, expect, it, vi } from "vitest";

vi.mock("./store", () => ({ drizzleRuntimeDeps: () => { throw new Error("db not available in tests"); } }));
vi.mock("./mailer", () => ({ sendCompanyEmail: vi.fn() }));

import type { generateStructured } from "@ae/core/ai/gateway";
import type { MarketBrief } from "@ae/core/company/research";
import { buildSearchQueries, runMarketResearchAgent, type SavedBrief } from "./market-research";
import { memoryRuntime } from "./runtime.testing";
import { sendCompanyEmail } from "./mailer";
import type { WebSearch } from "./web-search";

const env = { COMPANY_AGENTS_DAILY_BUDGET_USD: "5" };
const now = new Date("2026-11-07T11:00:00Z");

const fakeSearch = (cost = 6_000): { fn: WebSearch; calls: string[] } => {
  const calls: string[] = [];
  const fn: WebSearch = async (q, ctx) => {
    calls.push(q);
    await ctx.recordCost({ source: "ai_gateway", microUsd: cost, meta: {} });
    const n = calls.length;
    return { text: `result ${n}`, sources: [{ url: `https://site${n}.com/a`, title: `Site ${n}` }], microUsd: cost };
  };
  return { fn, calls };
};

const brief = (): MarketBrief => ({
  date: "x", headline: "AI agents are shipping", segments: [{ segment: "support", summary: "s", signals: ["sig"], notableCompanies: [
    { name: "Real", what: "agent", sourceUrls: ["https://site1.com/a"] }, { name: "Fake", what: "agent", sourceUrls: ["https://invented.com"] }] }],
  competitors: [{ name: "Comp", positioning: "p", pricing: "$99", sourceUrls: ["https://site6.com/a"] }, { name: "Ghost", positioning: "p", sourceUrls: ["https://invented.com"] }],
  pricingBenchmarks: [{ item: "i", value: "v", sourceUrl: "https://site6.com/a" }],
  opportunities: [{ title: "t", rationale: "r" }], sources: [],
});

const fakeGenerate = (b: MarketBrief = brief()) => vi.fn(async () => ({ object: b, text: "", usage: {} })) as unknown as typeof generateStructured & ReturnType<typeof vi.fn>;

describe("runMarketResearchAgent", () => {
  it("searches 6 queries, grounds the brief, saves it, records activity and never emails", async () => {
    const m = memoryRuntime();
    const search = fakeSearch();
    const generate = fakeGenerate();
    const saved: SavedBrief[] = [];
    const r = await runMarketResearchAgent({ trigger: "manual", now, env }, { runtime: m.deps, webSearch: search.fn, generate, saveBrief: async (b) => { saved.push(b); } });

    expect(r.status).toBe("ok");
    expect(search.calls).toHaveLength(6);
    expect(search.calls.length).toBeLessThanOrEqual(7);
    expect(search.calls.every((q) => q.includes("November 2026"))).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    const args = (generate as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.model).toBe("haiku");
    expect(args.prompt).toContain("<untrusted_data>");

    expect(saved).toHaveLength(1);
    expect(saved[0].briefDate).toBe("2026-11-07");
    expect(saved[0].brief.date).toBe("2026-11-07");
    expect(saved[0].brief.segments[0].notableCompanies.map((c) => c.name)).toEqual(["Real"]);
    expect(saved[0].brief.competitors.map((c) => c.name)).toEqual(["Comp"]);
    expect(saved[0].sources).toHaveLength(6);

    expect(m.activities[0]).toMatchObject({ status: "ok", counts: { searches: 6, sources: 6, competitors: 1, opportunities: 1 }, costMicroUsd: 36_000 });
    expect(m.activities[0].publicSummary).toBe("Wrote today's market brief: 1 segments, 1 competitors tracked, 6 sources.");
    expect(m.activities[0].publicSummary).not.toMatch(/Real|Comp/);
    expect(m.costs.every((c) => c.agent === "company:market_research")).toBe(true);
    expect(sendCompanyEmail).not.toHaveBeenCalled();
  });

  it("stops searching when the remaining budget is low and still writes a brief", async () => {
    const m = memoryRuntime();
    const search = fakeSearch(50_000);
    const saved: SavedBrief[] = [];
    // daily budget 0.5 USD -> run budget capped at 500k; each search burns 50k; reserve 60k+6k stops after ~8 -> use tiny daily budget
    const r = await runMarketResearchAgent({ trigger: "cron", now, env: { COMPANY_AGENTS_DAILY_BUDGET_USD: "0.2" } }, {
      runtime: m.deps, webSearch: search.fn, generate: fakeGenerate(), saveBrief: async (b) => { saved.push(b); },
    });
    expect(r.status).toBe("ok");
    expect(search.calls.length).toBeLessThan(6);
    expect(search.calls.length).toBeGreaterThan(0);
    expect(saved).toHaveLength(1);
  });

  it("skips (no brief) when every search fails", async () => {
    const m = memoryRuntime();
    const saved: SavedBrief[] = [];
    const r = await runMarketResearchAgent({ trigger: "cron", now, env }, {
      runtime: m.deps, webSearch: async () => { throw new Error("down"); }, generate: fakeGenerate(), saveBrief: async (b) => { saved.push(b); },
    });
    expect(r.status).toBe("skipped");
    expect(saved).toHaveLength(0);
    expect(m.activities[0].status).toBe("skipped");
  });

  it("builds at most 7 focused queries including competitors", () => {
    const q = buildSearchQueries(now);
    expect(q.length).toBeLessThanOrEqual(7);
    expect(q.at(-1)?.query).toContain("competitors");
  });
});
