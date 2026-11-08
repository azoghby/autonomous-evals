/** Command palette model: static destinations plus the viewer's recent evals, ranked by a small subsequence matcher. */

export type PaletteGroup = "Recent evals" | "Go to" | "Actions";

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  title: string;
  hint?: string;
  href: string;
  keywords?: string;
  /** Short right-aligned tag, e.g. a status or score. */
  meta?: string;
}

export const STATIC_ITEMS: readonly PaletteItem[] = [
  { id: "act:new-sandbox", group: "Actions", title: "New sandbox eval", hint: "Generate scenarios and run k trials", href: "/sandbox/new", keywords: "create start run" },
  { id: "act:compare", group: "Actions", title: "Compare two runs", hint: "Regressions, fixes and new failures", href: "/sandbox/compare", keywords: "diff delta regression versus vs" },
  { id: "act:new-request", group: "Actions", title: "Request an audit", hint: "Trace audit or full evaluation", href: "/start", keywords: "start job hire order" },
  { id: "act:keys", group: "Actions", title: "Manage API keys", href: "/settings/keys", keywords: "token mcp ci settings" },
  { id: "nav:evals", group: "Go to", title: "My evals", href: "/evals", keywords: "dashboard runs audits" },
  { id: "nav:jobs", group: "Go to", title: "My jobs", href: "/jobs", keywords: "dashboard audits orders" },
  { id: "nav:sandbox", group: "Go to", title: "Sandbox", href: "/sandbox", keywords: "simulator environment" },
  { id: "nav:sample", group: "Go to", title: "Sample report", href: "/sandbox/runs/sample", keywords: "example demo" },
  { id: "nav:leaderboard", group: "Go to", title: "Leaderboard", href: "/leaderboard", keywords: "rank public agents" },
  { id: "nav:demo", group: "Go to", title: "Demo", href: "/demo", keywords: "replay walkthrough" },
  { id: "nav:status", group: "Go to", title: "System status", href: "/status", keywords: "health uptime database cron" },
  { id: "nav:pricing", group: "Go to", title: "Pricing", href: "/pricing", keywords: "plans cost billing" },
  { id: "nav:home", group: "Go to", title: "Home", href: "/", keywords: "landing" },
];

export interface RecentEval { kind: string; id: string; name: string; status: string; createdAt: string; href: string; passHatK: number | null; detail: string }

export function recentItems(evals: readonly RecentEval[], limit = 6): PaletteItem[] {
  return evals.slice(0, limit).map((e) => ({
    id: `eval:${e.kind}:${e.id}`,
    group: "Recent evals" as const,
    title: e.name,
    hint: e.detail,
    href: e.href,
    keywords: `${e.kind === "job" ? "audit job" : "sandbox run"} ${e.status} ${e.id}`,
    meta: e.passHatK !== null ? `pass^k ${Math.round(e.passHatK * 100)}%` : e.status.replace(/_/g, " "),
  }));
}

/**
 * Score a query against text: 0 = no match. Prefers prefix, then word-start, then contiguous substring, then an
 * in-order subsequence (with a penalty for gaps). Case-insensitive.
 */
export function matchScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 100 - Math.min(t.length - q.length, 40) / 4;
  const idx = t.indexOf(q);
  if (idx >= 0) return (/[\s/_:-]/.test(t[idx - 1] ?? " ") ? 80 : 60) - Math.min(idx, 30) / 3;
  let ti = 0, gaps = 0, last = -1;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    if (last >= 0 && found > last + 1) gaps += 1;
    last = found;
    ti = found + 1;
  }
  return Math.max(1, 40 - gaps * 4);
}

const GROUP_ORDER: Record<PaletteGroup, number> = { "Recent evals": 0, Actions: 1, "Go to": 2 };

/** Filter and rank. Empty query keeps the curated order; otherwise best matches first (title weighs more than keywords). */
export function searchPalette(items: readonly PaletteItem[], query: string): PaletteItem[] {
  if (!query.trim()) return [...items].sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]);
  return items
    .map((item, i) => ({ item, i, s: Math.max(matchScore(query, item.title) * 1.2, matchScore(query, `${item.hint ?? ""} ${item.keywords ?? ""}`)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

/** Wraps an index into [0, length). */
export const wrapIndex = (i: number, length: number): number => (length === 0 ? 0 : ((i % length) + length) % length);
