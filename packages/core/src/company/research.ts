/**
 * Pure logic for the Market Research and Prospecting agents: segments, zod schemas for model output,
 * grounding (drop anything not backed by a search source), domain normalization, fit scoring, plan sanity,
 * dedupe, and the public-work-email acceptance rule. No I/O.
 */
import { z } from "zod";
import { PLAN_IDS, type PlanId } from "../pricing/plans";

/* ---------------- segments ---------------- */

export const SEGMENTS = [
  { id: "support", label: "customer support", query: "companies shipping customer-facing AI agents for customer support" },
  { id: "ops", label: "ops / back-office", query: "companies shipping AI agents for ops and back-office workflows" },
  { id: "fintech", label: "fintech", query: "fintech companies shipping customer-facing AI agents" },
  { id: "health_admin", label: "health admin (non-clinical)", query: "healthcare administration (non-clinical: scheduling, billing, intake) AI agent companies" },
  { id: "voice", label: "voice agents", query: "companies shipping voice AI agents" },
] as const;
export type SegmentId = (typeof SEGMENTS)[number]["id"];
export const SEGMENT_IDS = SEGMENTS.map((s) => s.id) as [SegmentId, ...SegmentId[]];

export const COMPETITOR_QUERY = "AI agent evaluation and testing tools (competitors) and their pricing";

/** Picks `count` segments, rotating by day-of-year so leads diversify across days. */
export function rotateSegments(now: Date, count = 3): Array<(typeof SEGMENTS)[number]> {
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const day = Math.floor((now.getTime() - start) / 86_400_000);
  const n = Math.min(count, SEGMENTS.length);
  return Array.from({ length: n }, (_, i) => SEGMENTS[(day * n + i) % SEGMENTS.length]);
}

export const monthYear = (now: Date): string => now.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/* ---------------- URL helpers ---------------- */

/** Canonical form used to compare URLs: no hash, no trailing slash, lowercase host. */
export function canonicalUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.hash = "";
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return null;
  }
}

export function allowedUrlSet(urls: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const u of urls) {
    const c = canonicalUrl(u);
    if (c) out.add(c);
  }
  return out;
}

const isAllowed = (url: string, allowed: ReadonlySet<string>): boolean => {
  const c = canonicalUrl(url);
  return c !== null && allowed.has(c);
};

/* ---------------- market brief ---------------- */

const Str = (max: number) => z.string().max(max);
const Urls = z.array(Str(500)).max(6);

export const MarketBriefSchema = z.object({
  date: Str(20),
  headline: Str(240),
  segments: z.array(z.object({
    segment: Str(60),
    summary: Str(900),
    notableCompanies: z.array(z.object({ name: Str(80), what: Str(300), sourceUrls: Urls })).max(6),
    signals: z.array(Str(240)).max(5),
  })).max(5),
  competitors: z.array(z.object({ name: Str(80), positioning: Str(400), pricing: Str(300).optional(), sourceUrls: Urls })).max(12),
  pricingBenchmarks: z.array(z.object({ item: Str(160), value: Str(160), sourceUrl: Str(500) })).max(12),
  opportunities: z.array(z.object({ title: Str(160), rationale: Str(500) })).max(6),
  sources: z.array(z.object({ url: Str(500), title: Str(200).optional() })).max(60),
});
export type MarketBrief = z.infer<typeof MarketBriefSchema>;

/** Drops every claim whose source URLs are not among the search sources. */
export function groundBrief(brief: MarketBrief, allowedUrls: Iterable<string>): MarketBrief {
  const allowed = allowedUrlSet(allowedUrls);
  const keep = (urls: string[]) => urls.filter((u) => isAllowed(u, allowed));
  return {
    ...brief,
    segments: brief.segments.map((s) => ({
      ...s,
      notableCompanies: s.notableCompanies
        .map((c) => ({ ...c, sourceUrls: keep(c.sourceUrls) }))
        .filter((c) => c.sourceUrls.length > 0),
    })),
    competitors: brief.competitors
      .map((c) => ({ ...c, sourceUrls: keep(c.sourceUrls) }))
      .filter((c) => c.sourceUrls.length > 0),
    pricingBenchmarks: brief.pricingBenchmarks.filter((p) => isAllowed(p.sourceUrl, allowed)),
    sources: brief.sources.filter((s) => isAllowed(s.url, allowed)),
  };
}

/* ---------------- domains ---------------- */

const GENERIC_HOSTS = [
  "github.com", "githubusercontent.com", "github.io", "producthunt.com", "ycombinator.com", "medium.com", "linkedin.com",
  "x.com", "twitter.com", "youtube.com", "youtu.be", "wikipedia.org", "facebook.com", "instagram.com", "reddit.com",
  "substack.com", "notion.site", "notion.so", "crunchbase.com", "techcrunch.com", "google.com", "apple.com", "npmjs.com",
  "pypi.org", "huggingface.co", "vercel.app", "netlify.app", "herokuapp.com", "gitlab.com", "bsky.app", "tiktok.com",
  "g2.com", "capterra.com", "trustpilot.com", "wordpress.com", "blogspot.com", "dev.to", "hackernoon.com", "forbes.com",
] as const;

const SECOND_LEVEL_LABELS = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Collapses a hostname to its registrable domain (heuristic: handles co.uk-style suffixes, no full PSL). */
function registrable(host: string): string {
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const take = tld.length === 2 && SECOND_LEVEL_LABELS.has(sld) ? 3 : 2;
  return labels.slice(-take).join(".");
}

export const isGenericHost = (domain: string): boolean => GENERIC_HOSTS.some((g) => domain === g || domain.endsWith(`.${g}`));

/** Returns the company's own registrable domain, or null when the input is an IP, localhost, malformed or a generic host. */
export function normalizeDomain(urlOrHost: string): string | null {
  let s = urlOrHost.trim().toLowerCase();
  if (!s || s.length > 300) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^@/]*@/, "");
  s = (s.split(/[/?#]/)[0] ?? "").replace(/:\d+$/, "").replace(/\.$/, "").replace(/^www\./, "");
  if (!s || s === "localhost" || s.endsWith(".localhost") || s.endsWith(".local") || s.endsWith(".internal")) return null;
  if (IPV4.test(s) || s.includes(":")) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  const domain = registrable(s);
  if (!/^[a-z]{2,}$/.test(domain.split(".").pop() ?? "")) return null;
  return isGenericHost(domain) ? null : domain;
}

/* ---------------- leads ---------------- */

export const LeadCandidateSchema = z.object({
  company: Str(120),
  domain: Str(200),
  segment: z.enum(SEGMENT_IDS),
  agentDescription: Str(400),
  evidence: z.array(z.object({ url: Str(500), note: Str(240).optional() })).max(5),
  fitScore: z.number(),
  fitReason: Str(400),
  recommendedPlan: z.enum(PLAN_IDS),
});
export type LeadCandidate = z.infer<typeof LeadCandidateSchema>;
export const ExtractedLeadsSchema = z.object({ leads: z.array(LeadCandidateSchema).max(25) });

/** Competitors (agent eval/testing tools) and ourselves are never prospects. */
export const EXCLUDED_DOMAINS: readonly string[] = [
  "braintrust.dev", "langchain.com", "langsmith.com", "arize.com", "galileo.ai", "patronus.ai", "confident-ai.com", "promptfoo.dev",
  "humanloop.com", "langfuse.com", "helicone.ai", "maxim.ai", "vellum.ai", "coval.dev", "coval.ai", "hamming.ai", "roark.ai",
  "cekura.ai", "scorecard.io", "agentops.ai", "weightsandbiases.com", "wandb.ai", "truera.com", "deepchecks.com", "evidentlyai.com",
  "standard-evals.vercel.app", "vercel.com", "openai.com", "anthropic.com",
];

/** Normalizes domains, keeps only evidence from search sources, drops leads with none or an unusable domain. */
export function groundLeads(leads: readonly LeadCandidate[], allowedUrls: Iterable<string>, excluded: readonly string[] = EXCLUDED_DOMAINS): LeadCandidate[] {
  const allowed = allowedUrlSet(allowedUrls);
  const out: LeadCandidate[] = [];
  for (const lead of leads) {
    const domain = normalizeDomain(lead.domain);
    if (!domain || excluded.some((e) => domain === e || domain.endsWith(`.${e}`))) continue;
    const evidence = lead.evidence.filter((e) => isAllowed(e.url, allowed));
    if (evidence.length === 0) continue;
    out.push({ ...lead, domain, evidence });
  }
  return out;
}

/** Clamp to 0..100 and adjust for evidence strength and how concrete the agent description is. */
export function scoreFit(lead: Pick<LeadCandidate, "fitScore" | "evidence" | "agentDescription">): number {
  let score = Number.isFinite(lead.fitScore) ? lead.fitScore : 0;
  score += Math.min(2, Math.max(0, lead.evidence.length - 1)) * 3;
  if (lead.agentDescription.trim().length < 20) score -= 15;
  return Math.round(Math.min(100, Math.max(0, score)));
}

export interface PlanSignals { isLarge: boolean; isHighVolume: boolean }

export function planSignals(lead: Pick<LeadCandidate, "agentDescription" | "fitReason">): PlanSignals {
  const text = `${lead.agentDescription} ${lead.fitReason}`.toLowerCase();
  return {
    isLarge: /fortune \d+|publicly traded|nasdaq|nyse|thousands of employees|\b\d{1,3}(,\d{3})+\+? employees|global enterprise|large enterprise/.test(text),
    isHighVolume: /millions of|high[- ]volume|at scale|many agents|multiple agents|agent platform|24\/7 .*(thousands|millions)/.test(text),
  };
}

/** Enterprise only for clearly large companies with a strong fit; Scale for volume; Developer for weak fits; default Pro. */
export function recommendPlan(fit: number, signals: PlanSignals): PlanId {
  if (signals.isLarge && fit >= 70) return "enterprise";
  if (signals.isHighVolume && fit >= 60) return "scale";
  if (fit < 40) return "developer";
  return "pro";
}

/** Applies scoring + plan sanity to grounded leads. */
export function finalizeLeads(leads: readonly LeadCandidate[]): LeadCandidate[] {
  return leads.map((l) => {
    const fitScore = scoreFit(l);
    return { ...l, fitScore, recommendedPlan: recommendPlan(fitScore, planSignals(l)) };
  });
}

/** One lead per domain (highest fit wins), sorted by fit desc. */
export function dedupeLeads<T extends Pick<LeadCandidate, "domain" | "fitScore">>(leads: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const l of leads) {
    const cur = best.get(l.domain);
    if (!cur || l.fitScore > cur.fitScore) best.set(l.domain, l);
  }
  return [...best.values()].sort((a, b) => b.fitScore - a.fitScore);
}

/* ---------------- public work email ---------------- */

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "qq.com",
  "163.com", "fastmail.com", "hey.com", "tutanota.com",
]);
const NO_REPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer-daemon|postmaster|abuse|bounce|unsubscribe|privacy|legal|dmca)/;
const PLACEHOLDER = /^(jane|john|jdoe|janedoe|johndoe|test|testing|example|user|username|name|email|you|your|someone|foo|bar|sample|demo|firstname|lastname|first|last)$/;
const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@([a-z0-9-]+(\.[a-z0-9-]+)+)$/;

export const ROLE_LOCAL_PARTS = ["founders", "founder", "hello", "sales", "partnerships", "partners", "contact", "info", "team", "business", "bd"] as const;
export const isRoleAddress = (email: string): boolean => (ROLE_LOCAL_PARTS as readonly string[]).includes(email.split("@")[0] ?? "");

export type EmailAcceptance = { ok: true; email: string } | { ok: false; reason: string };

/** The only gate for storing a contact: lead's own domain, not free-mail, not no-reply, published at a public http(s) URL. */
export function acceptPublicWorkEmail(email: string, leadDomain: string, sourceUrl: string | null | undefined): EmailAcceptance {
  const e = email.trim().toLowerCase();
  const m = EMAIL_RE.exec(e);
  if (!m) return { ok: false, reason: "malformed" };
  const host = m[1];
  if (FREE_MAIL.has(host) || FREE_MAIL.has(registrable(host))) return { ok: false, reason: "free_mail" };
  const dom = leadDomain.trim().toLowerCase();
  if (!dom || (host !== dom && !host.endsWith(`.${dom}`))) return { ok: false, reason: "domain_mismatch" };
  if (NO_REPLY.test(e.split("@")[0])) return { ok: false, reason: "non_contact_role" };
  if (PLACEHOLDER.test(e.split("@")[0])) return { ok: false, reason: "placeholder" };
  if (!sourceUrl || !canonicalUrl(sourceUrl)) return { ok: false, reason: "no_public_source" };
  return { ok: true, email: e };
}

/* ---------------- prompts (pure) ---------------- */

export interface SearchEvidence { label: string; text: string; sources: Array<{ url: string; title?: string }> }

const clean = (s: string): string => s.replace(/<\/?untrusted_data>/gi, "");

/** Numbered source list + search texts, wrapped as untrusted data. Returns the prompt and the URLs the model may cite. */
export function buildEvidenceBlock(searches: readonly SearchEvidence[], maxTextChars = 3000): { block: string; urls: string[] } {
  const urls: string[] = [];
  const seen = new Set<string>();
  const texts = searches.map((s) => `### ${clean(s.label)}\n${clean(s.text).slice(0, maxTextChars)}`);
  const sourceLines: string[] = [];
  for (const s of searches) {
    for (const src of s.sources) {
      if (seen.has(src.url)) continue;
      seen.add(src.url);
      urls.push(src.url);
      sourceLines.push(`[${urls.length}] ${clean(src.url)}${src.title ? ` - ${clean(src.title).slice(0, 120)}` : ""}`);
    }
  }
  const block = `<untrusted_data>\n${texts.join("\n\n")}\n\nSOURCES (cite only these exact URLs):\n${sourceLines.join("\n")}\n</untrusted_data>`;
  return { block, urls };
}
