import "server-only";
/**
 * Prospecting agent: finds companies shipping customer-facing AI agents from PUBLIC web sources, grounds every lead
 * in search-result URLs, dedupes by domain, stores leads, and looks up publicly listed work emails (Monid).
 * It NEVER contacts anyone: it does not import the mailer and only writes prospect_leads.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { GatewayError, generateStructured } from "@ae/core/ai/gateway";
import { COMPANY_AGENTS } from "@ae/core/company/registry";
import {
  ExtractedLeadsSchema, buildEvidenceBlock, dedupeLeads, finalizeLeads, groundLeads, monthYear, rotateSegments,
  type LeadCandidate, type SearchEvidence,
} from "@ae/core/company/research";
import { runCompanyAgent, type AgentRunContext, type AgentRunOutcome, type RunOptions, type RunResult, type RuntimeDeps } from "./runtime";
import { gatewayWebSearch, type WebSearch } from "./web-search";
import { companyStructured } from "./structured";
import { withNaive } from "./naive-runtime";
import { ContactFinderError, defaultContactFinder, pickContact, type ContactFinder } from "./contacts";
import { getLatestBrief } from "./market-research";

export type CompanyRunOptions = Omit<RunOptions, "deps">;

export const MAX_NEW_LEADS = 15;
export const MAX_CONTACT_LOOKUPS = 5;
export const MIN_FIT_FOR_CONTACT = 60;
const SEGMENTS_PER_RUN = 3;
const SYNTHESIS_RESERVE_MICRO_USD = 60_000;
const SEARCH_ESTIMATE_MICRO_USD = 6_000;
const LOOKUP_MIN_REMAINING_MICRO_USD = 30_000;

export type LeadStatus = "new" | "drafted" | "contacted" | "replied" | "opted_in" | "disqualified" | "suppressed";

export interface StoredLead {
  id: string; domain: string; company: string; segment: string; agentDescription: string;
  evidence: Array<{ url: string; note?: string }>; fitScore: number; fitReason: string; recommendedPlan: string;
  contactEmail: string | null; contactName: string | null; contactRole: string | null; contactSource: string | null;
  status: string; createdAt: Date;
}

export interface ContactUpdate { contactEmail: string; contactName: string | null; contactRole: string | null; contactSource: string }

export interface ProspectingStore {
  existingDomains(domains: string[]): Promise<Set<string>>;
  /** Inserts with onConflictDoNothing on domain; returns only the rows actually inserted. */
  insertLeads(leads: LeadCandidate[], activityId: string): Promise<Array<{ id: string; domain: string; fitScore: number }>>;
  isSuppressed(email: string): Promise<boolean>;
  setContact(leadId: string, c: ContactUpdate): Promise<void>;
  setStatus(leadId: string, status: LeadStatus): Promise<void>;
  seedCompanies(): Promise<string[]>;
}

export interface ProspectingDeps {
  runtime: RuntimeDeps | undefined;
  webSearch: WebSearch;
  generate: typeof generateStructured;
  store: ProspectingStore;
  contactFinder: ContactFinder;
}

export function buildProspectQueries(now: Date): Array<{ label: string; query: string }> {
  const when = monthYear(now);
  return rotateSegments(now, SEGMENTS_PER_RUN).flatMap((s) => [
    {
      label: s.label,
      query: `As of ${when}: list 10 to 15 startups (for example from the Y Combinator company directory, recent batches) that ship customer-facing AI agents for ${s.label}. For each give the company name, its own website domain, one sentence on what the agent does, and a product URL. Cite sources.`,
    },
    {
      label: s.label,
      query: `As of ${when}: recent Product Hunt launches, funding announcements or GitHub projects of companies shipping production AI agents for ${s.label} (multi-turn agents that take actions through tools). List up to 10 with company name, own website domain, what the agent does, and a source URL each.`,
    },
  ]);
}

export function buildLeadPrompt(block: string, seeds: readonly string[]): string {
  const seedLine = seeds.length > 0 ? `Companies from our latest market brief (unverified hints, include only if the evidence supports them): ${seeds.join(", ")}\n\n` : "";
  return `Extract up to 20 candidate leads from the evidence below. "domain" must be the company's OWN website domain (not github, producthunt, ycombinator, linkedin, medium, etc.). "evidence" urls must be copied verbatim from the SOURCES list. Skip companies that build agent evaluation/testing tools.
segment must be one of: support, ops, fintech, health_admin, voice. recommendedPlan is one of developer, pro, scale, enterprise.

${seedLine}${block}`;
}

async function collectSearches(ctx: AgentRunContext, webSearch: WebSearch): Promise<SearchEvidence[]> {
  const out: SearchEvidence[] = [];
  for (const q of buildProspectQueries(ctx.now)) {
    if (ctx.remainingMicroUsd() < SYNTHESIS_RESERVE_MICRO_USD + SEARCH_ESTIMATE_MICRO_USD) break;
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

async function enrichContacts(
  ctx: AgentRunContext, deps: ProspectingDeps, inserted: Array<{ id: string; domain: string; fitScore: number }>,
): Promise<number> {
  const targets = inserted.filter((l) => l.fitScore >= MIN_FIT_FOR_CONTACT).sort((a, b) => b.fitScore - a.fitScore).slice(0, MAX_CONTACT_LOOKUPS);
  let found = 0;
  for (const lead of targets) {
    if (ctx.remainingMicroUsd() < LOOKUP_MIN_REMAINING_MICRO_USD) { ctx.log("contacts_stopped_low_budget"); break; }
    try {
      const lookup = await deps.contactFinder.find(lead.domain);
      await ctx.recordCost(lookup.microUsd, { tool: "monid", provider: "hunterio", endpoint: "/domain-search", domain: lead.domain });
      const picked = pickContact(lookup.candidates, lead.domain);
      if (!picked) { ctx.log("contact_none", { domain: lead.domain, candidates: lookup.candidates.length }); continue; }
      if (await deps.store.isSuppressed(picked.email)) {
        await deps.store.setStatus(lead.id, "suppressed");
        ctx.log("contact_suppressed", { domain: lead.domain });
        continue;
      }
      await deps.store.setContact(lead.id, { contactEmail: picked.email, contactName: picked.name, contactRole: picked.role, contactSource: picked.sourceUrl });
      found++;
    } catch (err) {
      const code = err instanceof ContactFinderError ? err.code : "error";
      ctx.log("contact_lookup_failed", { domain: lead.domain, code, error: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
      if (code === "not_configured" || code === "blocked") break;
    }
  }
  return found;
}

async function runProspecting(ctx: AgentRunContext, deps: ProspectingDeps): Promise<AgentRunOutcome> {
  const searches = await collectSearches(ctx, deps.webSearch);
  const zero = { searches: searches.length, candidates: 0, newLeads: 0, duplicates: 0, contactsFound: 0 };
  if (searches.length === 0) {
    return { status: "skipped", summary: "No web searches succeeded; no leads.", publicSummary: "No leads today: web research was unavailable.", counts: zero };
  }
  const { block, urls } = buildEvidenceBlock(searches);
  const seeds = await deps.store.seedCompanies();
  const res = await deps.generate({
    model: "haiku", system: COMPANY_AGENTS.prospecting.system, prompt: buildLeadPrompt(block, seeds),
    schema: ExtractedLeadsSchema, ctx: ctx.gateway, maxOutputTokens: 6000,
  });

  const candidates = dedupeLeads(finalizeLeads(groundLeads(res.object.leads, urls)));
  const existing = await deps.store.existingDomains(candidates.map((c) => c.domain));
  const fresh = candidates.filter((c) => !existing.has(c.domain)).slice(0, MAX_NEW_LEADS);
  const inserted = fresh.length > 0 ? await deps.store.insertLeads(fresh, ctx.activityId) : [];
  const contactsFound = inserted.length > 0 ? await enrichContacts(ctx, deps, inserted) : 0;

  const counts = {
    searches: searches.length, candidates: candidates.length, newLeads: inserted.length,
    duplicates: candidates.length - inserted.length, contactsFound,
  };
  return {
    summary: `Found ${counts.newLeads} new leads (${counts.duplicates} already known), ${contactsFound} with a public work email. Nothing was contacted.`,
    publicSummary: `Added ${counts.newLeads} new leads from ${counts.searches} searches (${counts.duplicates} duplicates skipped, ${contactsFound} with a public contact).`,
    counts,
    detail: { domains: inserted.map((l) => l.domain), neverContacted: true },
  };
}

/* ---------------- persistence ---------------- */

export function drizzleProspectingStore(): ProspectingStore {
  const t = () => schema.prospectLeads;
  return {
    async existingDomains(domains) {
      if (domains.length === 0) return new Set();
      const rows = await db().select({ d: t().domain }).from(t()).where(inArray(t().domain, domains));
      return new Set(rows.map((r) => r.d));
    },
    async insertLeads(leads, activityId) {
      return db().insert(t()).values(leads.map((l) => ({
        domain: l.domain, company: l.company, segment: l.segment, agentDescription: l.agentDescription, evidence: l.evidence,
        fitScore: l.fitScore, fitReason: l.fitReason, recommendedPlan: l.recommendedPlan, activityId,
      }))).onConflictDoNothing({ target: t().domain }).returning({ id: t().id, domain: t().domain, fitScore: t().fitScore });
    },
    async isSuppressed(email) {
      const s = schema.contactSuppressions;
      const [row] = await db().select({ id: s.id }).from(s).where(sql`lower(${s.email}) = ${email.toLowerCase()}`).limit(1);
      return Boolean(row);
    },
    async setContact(leadId, c) {
      await db().update(t()).set({ ...c, updatedAt: new Date() }).where(eq(t().id, leadId));
    },
    async setStatus(leadId, status) {
      await db().update(t()).set({ status, updatedAt: new Date() }).where(eq(t().id, leadId));
    },
    async seedCompanies() {
      try {
        const latest = await getLatestBrief();
        const names = latest?.brief?.segments.flatMap((s) => s.notableCompanies.map((c) => c.name)) ?? [];
        return [...new Set(names)].slice(0, 15);
      } catch {
        return [];
      }
    },
  };
}

export async function listLeads(opts: { status?: string; limit?: number } = {}): Promise<StoredLead[]> {
  const q = db().select().from(schema.prospectLeads);
  const filtered = opts.status ? q.where(and(eq(schema.prospectLeads.status, opts.status))) : q;
  return filtered.orderBy(desc(schema.prospectLeads.fitScore), desc(schema.prospectLeads.createdAt)).limit(Math.min(Math.max(1, opts.limit ?? 50), 200));
}

/* ---------------- entry point ---------------- */

export async function runProspectingAgent(
  opts: CompanyRunOptions = { trigger: "cron" },
  deps: Partial<ProspectingDeps> = {},
): Promise<RunResult> {
  const d: ProspectingDeps = {
    runtime: deps.runtime,
    webSearch: deps.webSearch ?? gatewayWebSearch,
    generate: deps.generate ?? withNaive("prospecting", companyStructured),
    store: deps.store ?? drizzleProspectingStore(),
    contactFinder: deps.contactFinder ?? defaultContactFinder(opts.env ?? process.env),
  };
  return runCompanyAgent("prospecting", { ...opts, deps: d.runtime }, (ctx) => runProspecting(ctx, d));
}
