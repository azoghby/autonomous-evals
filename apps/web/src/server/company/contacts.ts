import "server-only";
/**
 * Contact research for prospects: asks Monid (Hunter domain-search) for emails already PUBLISHED on the web for a
 * lead's own domain. Only publicly listed work emails with a public source URL are kept; nothing is guessed or
 * pattern-generated. The client is behind an injectable ContactFinder so tests never touch the network.
 */
import { acceptPublicWorkEmail, isRoleAddress } from "@ae/core/company/research";

export { acceptPublicWorkEmail };

const MONID_BASE = "https://api.monid.ai";
const MONID_PROVIDER = "hunterio";
const MONID_ENDPOINT = "/domain-search";
/** Hunter bills ~$0.0245 per started block of 10 addresses; used when Monid reports no cost. */
export const MONID_FALLBACK_MICRO_USD = 25_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 20;

export interface ContactCandidate {
  email: string;
  name: string | null;
  role: string | null;
  /** Best public URL where the address is published. */
  sourceUrl: string | null;
  /** All public URLs where it was seen (live pages first). */
  sourceUrls: string[];
  confidence: number | null;
  isGeneric: boolean;
  verification: string | null;
}

export interface ContactLookup { candidates: ContactCandidate[]; microUsd: number }

export interface ContactFinder {
  find(domain: string): Promise<ContactLookup>;
}

export class ContactFinderError extends Error {
  constructor(readonly code: "not_configured" | "request_failed" | "blocked" | "timeout", message: string) {
    super(message);
  }
}

/* ---------------- parsing ---------------- */

interface HunterSource { uri?: unknown; still_on_page?: unknown }
interface HunterEmail {
  value?: unknown; type?: unknown; confidence?: unknown; sources?: unknown;
  first_name?: unknown; last_name?: unknown; position?: unknown; verification?: { status?: unknown } | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function sourceList(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  const list = (sources as HunterSource[]).filter((s) => typeof s.uri === "string");
  return [...list.filter((s) => s.still_on_page === true), ...list.filter((s) => s.still_on_page !== true)].map((s) => String(s.uri));
}

/** Converts a Monid/Hunter domain-search output document into candidates. Tolerates missing fields. */
export function parseHunterOutput(output: unknown): ContactCandidate[] {
  const emails = (output as { data?: { emails?: unknown } } | null)?.data?.emails;
  if (!Array.isArray(emails)) return [];
  const out: ContactCandidate[] = [];
  for (const e of emails as HunterEmail[]) {
    const email = str(e.value);
    if (!email) continue;
    const name = [str(e.first_name), str(e.last_name)].filter(Boolean).join(" ") || null;
    out.push({
      email: email.toLowerCase(), name, role: str(e.position), sourceUrl: sourceList(e.sources)[0] ?? null, sourceUrls: sourceList(e.sources),
      confidence: typeof e.confidence === "number" ? e.confidence : null,
      isGeneric: e.type === "generic", verification: str(e.verification?.status),
    });
  }
  return out;
}

/* ---------------- selection ---------------- */

export interface PickedContact { email: string; name: string | null; role: string | null; sourceUrl: string }

const BAD_VERIFICATION = new Set(["invalid", "disposable", "webmail"]);

function rank(c: ContactCandidate): number {
  let score = c.confidence ?? 50;
  if (isRoleAddress(c.email)) score += 40;
  else if (c.name && /founder|ceo|cto|head|vp|director|partner|chief/i.test(c.role ?? "")) score += 25;
  else if (c.name) score += 5;
  if (c.verification === "valid") score += 10;
  return score;
}

const hostOf = (u: string): string | null => {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
};

/**
 * A source is trustworthy when it is on the lead's own site, or the address appears on 3+ distinct sites. A single
 * third-party page (docs examples, scraped directories) is not enough: it may be a placeholder address.
 */
export function trustedSource(c: ContactCandidate, leadDomain: string): string | null {
  const own = c.sourceUrls.find((u) => { const h = hostOf(u); return h !== null && (h === leadDomain || h.endsWith(`.${leadDomain}`)); });
  if (own) return own;
  const hosts = new Set(c.sourceUrls.map(hostOf).filter(Boolean));
  return hosts.size >= 3 ? (c.sourceUrls[0] ?? null) : null;
}

/** Best acceptable contact: passes acceptPublicWorkEmail, role/founder addresses first. Null if none qualifies. */
export function pickContact(candidates: readonly ContactCandidate[], leadDomain: string): PickedContact | null {
  const ok = candidates
    .filter((c) => !BAD_VERIFICATION.has(c.verification ?? ""))
    .map((c) => ({ c, src: trustedSource(c, leadDomain) }))
    .filter((x): x is { c: ContactCandidate; src: string } => x.src !== null && acceptPublicWorkEmail(x.c.email, leadDomain, x.src).ok)
    .sort((a, b) => rank(b.c) - rank(a.c));
  const best = ok[0];
  return best ? { email: best.c.email, name: best.c.name, role: best.c.role, sourceUrl: best.src } : null;
}

/* ---------------- Monid HTTP client ---------------- */

interface MonidRun {
  runId?: string; status?: string; output?: unknown;
  billing?: { reportedCost?: { value?: number; unit?: string } };
}

export interface MonidClientOptions {
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

const TERMINAL_BAD = new Set(["FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"]);

function reportedMicroUsd(run: MonidRun): number {
  const c = run.billing?.reportedCost;
  return c && typeof c.value === "number" && c.unit === "MICRO_DOLLAR" ? Math.round(c.value) : MONID_FALLBACK_MICRO_USD;
}

export function createMonidContactFinder(opts: MonidClientOptions): ContactFinder {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = opts.baseUrl ?? MONID_BASE;

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<MonidRun> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok && res.status !== 200) throw new ContactFinderError("request_failed", `Monid HTTP ${res.status}`);
    return (await res.json()) as MonidRun;
  }

  return {
    async find(domain) {
      if (!opts.apiKey) throw new ContactFinderError("not_configured", "MONID_API_KEY is not set");
      let run = await call("POST", "/v1/run", {
        provider: MONID_PROVIDER, endpoint: MONID_ENDPOINT,
        input: { body: { domain, limit: 10 } },
      });
      for (let i = 0; run.status !== "COMPLETED" && !TERMINAL_BAD.has(run.status ?? "") && run.runId && i < MAX_POLLS; i++) {
        await sleep(POLL_INTERVAL_MS);
        run = await call("GET", `/v1/runs/${encodeURIComponent(run.runId)}`);
      }
      if (run.status === "BLOCKED") throw new ContactFinderError("blocked", "Monid run blocked (wallet/budget)");
      if (run.status !== "COMPLETED") throw new ContactFinderError(run.status === "TIMED_OUT" ? "timeout" : "request_failed", `Monid run ${run.status ?? "unknown"}`);
      return { candidates: parseHunterOutput(run.output), microUsd: reportedMicroUsd(run) };
    },
  };
}

/** Default finder from env; lookups are skipped (not_configured) when MONID_API_KEY is missing. */
export function defaultContactFinder(env: Record<string, string | undefined> = process.env): ContactFinder {
  return createMonidContactFinder({ apiKey: env.MONID_API_KEY });
}
