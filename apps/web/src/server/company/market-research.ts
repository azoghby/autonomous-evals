import "server-only";
/**
 * Market Research agent: one web search per segment (+ competitors), one haiku synthesis into a dated, source-grounded
 * brief, upserted into market_briefs (one row per UTC day). Reads public web sources only; contacts no one.
 */
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { GatewayError, generateStructured } from "@ae/core/ai/gateway";
import { COMPANY_AGENTS } from "@ae/core/company/registry";
import { dayKey } from "@ae/core/company/policy";
import {
  COMPETITOR_QUERY, MarketBriefSchema, SEGMENTS, buildEvidenceBlock, groundBrief, monthYear,
  type MarketBrief, type SearchEvidence,
} from "@ae/core/company/research";
import { runCompanyAgent, type AgentRunContext, type AgentRunOutcome, type RunOptions, type RunResult, type RuntimeDeps } from "./runtime";
import { gatewayWebSearch, type WebSearch } from "./web-search";
import { companyStructured } from "./structured";

export type CompanyRunOptions = Omit<RunOptions, "deps">;

export const MAX_SEARCHES = 7;
/** Stop searching when less than this is left, so the synthesis call can still run (micro-USD). */
export const SYNTHESIS_RESERVE_MICRO_USD = 60_000;
const SEARCH_ESTIMATE_MICRO_USD = 6_000;

export interface SavedBrief {
  briefDate: string;
  activityId: string;
  brief: MarketBrief;
  sources: Array<{ url: string; title?: string }>;
  costMicroUsd: number;
}

export interface MarketResearchDeps {
  runtime: RuntimeDeps | undefined;
  webSearch: WebSearch;
  generate: typeof generateStructured;
  saveBrief(b: SavedBrief): Promise<void>;
}

export function buildSearchQueries(now: Date): Array<{ label: string; query: string }> {
  const when = monthYear(now);
  return [
    ...SEGMENTS.map((s) => ({
      label: s.label,
      query: `As of ${when}: ${s.query}. Name the notable companies, what their agents do, recent launches or funding, and any public pricing. Cite sources.`,
    })),
    { label: "competitors", query: `As of ${when}: ${COMPETITOR_QUERY}. For each tool give positioning and public pricing. Cite sources.` },
  ].slice(0, MAX_SEARCHES);
}

async function collectSearches(ctx: AgentRunContext, webSearch: WebSearch): Promise<SearchEvidence[]> {
  const out: SearchEvidence[] = [];
  for (const q of buildSearchQueries(ctx.now)) {
    if (ctx.remainingMicroUsd() < SYNTHESIS_RESERVE_MICRO_USD + SEARCH_ESTIMATE_MICRO_USD) {
      ctx.log("search_stopped_low_budget", { remainingMicroUsd: ctx.remainingMicroUsd() });
      break;
    }
    try {
      const res = await webSearch(q.query, ctx.gateway);
      out.push({ label: q.label, text: res.text, sources: res.sources.map((s) => ({ url: s.url, title: s.title })) });
    } catch (err) {
      if (err instanceof GatewayError && err.code === "budget_exhausted") break;
      ctx.log("search_failed", { label: q.label, error: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
    }
  }
  return out;
}

export function buildBriefPrompt(date: string, block: string): string {
  return `Write the market brief dated ${date}. Cover each segment (support, ops/back-office, fintech, health admin non-clinical, voice), competitors with public pricing, pricing benchmarks, and opportunities for Standard Evals.
Every named company, competitor and pricing benchmark must cite sourceUrls/sourceUrl taken verbatim from the SOURCES list. Leave out anything you cannot source. Be concise: at most 4 companies per segment, 8 competitors, 8 pricing benchmarks, 4 opportunities, 1-2 sentences per field, and leave "sources" empty (we attach them). Set "date" to ${date}.

${block}`;
}

async function runResearch(ctx: AgentRunContext, deps: MarketResearchDeps): Promise<AgentRunOutcome> {
  const searches = await collectSearches(ctx, deps.webSearch);
  if (searches.length === 0) {
    return { status: "skipped", summary: "No web searches succeeded; no brief written.", publicSummary: "No brief today: web research was unavailable.", counts: { searches: 0, sources: 0, competitors: 0, opportunities: 0 } };
  }
  const date = dayKey(ctx.now);
  const { block, urls } = buildEvidenceBlock(searches);
  const synth = (model: "haiku" | "sonnet") => deps.generate({
    model, system: COMPANY_AGENTS.market_research.system, prompt: buildBriefPrompt(date, block),
    schema: MarketBriefSchema, ctx: ctx.gateway, maxOutputTokens: 12000,
  });
  let res: Awaited<ReturnType<typeof synth>>;
  try {
    res = await synth("haiku");
  } catch (err) {
    // Haiku occasionally answers in prose for long evidence blocks; retry once on the stronger model.
    if (!(err instanceof GatewayError) || err.code !== "malformed_output") throw err;
    ctx.log("synthesis_retry", { error: err.message.slice(0, 200), raw: (err.details.raw ?? "").slice(0, 200) });
    res = await synth("sonnet");
  }
  const grounded = groundBrief({ ...res.object, date }, urls);
  const titles = new Map(searches.flatMap((s) => s.sources.map((x) => [x.url, x.title] as const)));
  const sources = urls.slice(0, 60).map((url) => ({ url, ...(titles.get(url) ? { title: titles.get(url) } : {}) }));
  const brief: MarketBrief = { ...grounded, sources };
  await deps.saveBrief({ briefDate: date, activityId: ctx.activityId, brief, sources, costMicroUsd: Math.round(ctx.spentMicroUsd()) });

  const counts = { searches: searches.length, sources: sources.length, competitors: brief.competitors.length, opportunities: brief.opportunities.length };
  return {
    summary: `Wrote ${date} brief: ${brief.headline}`,
    publicSummary: `Wrote today's market brief: ${brief.segments.length} segments, ${counts.competitors} competitors tracked, ${counts.sources} sources.`,
    counts,
    detail: { date, dryRun: ctx.dryRun },
  };
}

/* ---------------- persistence ---------------- */

async function saveBriefToDb(b: SavedBrief): Promise<void> {
  const t = schema.marketBriefs;
  const row = { briefDate: b.briefDate, activityId: b.activityId, brief: b.brief, sources: b.sources, costMicroUsd: b.costMicroUsd };
  await db().insert(t).values(row).onConflictDoUpdate({ target: t.briefDate, set: { activityId: b.activityId, brief: b.brief, sources: b.sources, costMicroUsd: b.costMicroUsd, createdAt: new Date() } });
}

export interface StoredBrief { briefDate: string; brief: MarketBrief | null; sources: Array<{ url: string; title?: string }>; costMicroUsd: number; createdAt: Date }

function toStored(r: typeof schema.marketBriefs.$inferSelect): StoredBrief {
  const parsed = MarketBriefSchema.safeParse(r.brief);
  return { briefDate: r.briefDate, brief: parsed.success ? parsed.data : null, sources: r.sources, costMicroUsd: r.costMicroUsd, createdAt: r.createdAt };
}

export async function getLatestBrief(): Promise<StoredBrief | null> {
  const t = schema.marketBriefs;
  const [row] = await db().select().from(t).orderBy(desc(t.briefDate)).limit(1);
  return row ? toStored(row) : null;
}

export async function getBriefByDate(briefDate: string): Promise<StoredBrief | null> {
  const t = schema.marketBriefs;
  const [row] = await db().select().from(t).where(eq(t.briefDate, briefDate)).limit(1);
  return row ? toStored(row) : null;
}

export async function listBriefs(limit = 14): Promise<StoredBrief[]> {
  const t = schema.marketBriefs;
  const rows = await db().select().from(t).orderBy(desc(t.briefDate)).limit(Math.min(Math.max(1, limit), 90));
  return rows.map(toStored);
}

/* ---------------- entry point ---------------- */

export async function runMarketResearchAgent(
  opts: CompanyRunOptions = { trigger: "cron" },
  deps: Partial<MarketResearchDeps> = {},
): Promise<RunResult> {
  const d: MarketResearchDeps = {
    runtime: deps.runtime,
    webSearch: deps.webSearch ?? gatewayWebSearch,
    generate: deps.generate ?? companyStructured,
    saveBrief: deps.saveBrief ?? saveBriefToDb,
  };
  return runCompanyAgent("market_research", { ...opts, deps: d.runtime }, (ctx) => runResearch(ctx, d));
}
