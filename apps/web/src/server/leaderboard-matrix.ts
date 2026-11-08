/**
 * Agent x model matrix for the leaderboard page. Pure (no DB): built from ranked entries.
 * One open-source agent is run on several models; its rows share a slug prefix (`<agent>--<model>`) and a display name
 * prefix (`<Agent name> · <Model>`). This groups them into one row per agent with one cell per model.
 */
import type { RankedEntry } from "./leaderboard";

export interface MatrixCell { slug: string; passRate: number; redTeamRate: number | null; criticalCount: number; rank: number }
export interface MatrixRow {
  key: string;
  name: string;
  vendor: string;
  kind: string;
  homepage: string | null;
  termsUrl: string | null;
  cells: Record<string, MatrixCell>;
  best: number;
  mean: number;
  runs: number;
}
export interface MatrixColumn { model: string; label: string }
export interface AgentMatrix { columns: MatrixColumn[]; rows: MatrixRow[] }

const MODEL_LABELS: Record<string, string> = {
  "anthropic/claude-opus-5.5": "Claude Opus 5.5",
  "anthropic/claude-sonnet-5.5": "Claude Sonnet 5.5",
  "anthropic/claude-sonnet-4.5": "Claude Sonnet 4.5",
  "openai/gpt-5.5": "GPT-5.5",
  "google/gemini-3.8-flash": "Gemini 3.8 Flash",
};
/** Model id -> short column label ("openai/gpt-5.5" -> "GPT-5.5"; unknown ids fall back to the part after the slash). */
export const modelLabel = (model: string): string => MODEL_LABELS[model] ?? model.split("/").pop() ?? model;

export const agentKey = (slug: string): string => slug.split("--")[0] ?? slug;
export const agentName = (name: string): string => name.split(" · ")[0]!.trim();

type MatrixInput = Pick<RankedEntry, "slug" | "name" | "vendor" | "kind" | "model" | "passRate" | "redTeamRate" | "criticalCount" | "rank"> & {
  homepage?: string | null; termsUrl?: string | null;
};

/** Groups entries into one row per agent. Columns: models ordered by how many agents ran on them, then label. */
export function buildAgentMatrix(entries: readonly MatrixInput[]): AgentMatrix {
  const rows = new Map<string, MatrixRow>();
  const modelCount = new Map<string, number>();
  for (const e of entries) {
    if (!e.model) continue;
    const key = agentKey(e.slug);
    const row = rows.get(key) ?? {
      key, name: agentName(e.name), vendor: e.vendor, kind: e.kind, homepage: e.homepage ?? null, termsUrl: e.termsUrl ?? null,
      cells: {}, best: 0, mean: 0, runs: 0,
    };
    if (row.cells[e.model]) continue; // first (best-ranked) entry per agent+model wins
    row.cells[e.model] = { slug: e.slug, passRate: e.passRate, redTeamRate: e.redTeamRate, criticalCount: e.criticalCount, rank: e.rank };
    row.homepage ??= e.homepage ?? null;
    row.termsUrl ??= e.termsUrl ?? null;
    rows.set(key, row);
    modelCount.set(e.model, (modelCount.get(e.model) ?? 0) + 1);
  }
  const finished = [...rows.values()].map((r) => {
    const rates = Object.values(r.cells).map((c) => c.passRate);
    return { ...r, runs: rates.length, best: Math.max(...rates), mean: rates.reduce((a, b) => a + b, 0) / rates.length };
  });
  const columns = [...modelCount.entries()]
    .sort((a, b) => b[1] - a[1] || modelLabel(a[0]).localeCompare(modelLabel(b[0])))
    .map(([model]) => ({ model, label: modelLabel(model) }));
  return { columns, rows: sortMatrixRows(finished, "mean", "desc") };
}

export type MatrixSortKey = "name" | "mean" | "best" | `model:${string}`;

/** Sorted copy. Missing model cells always sort last; ties break on mean, then name. */
export function sortMatrixRows(rows: readonly MatrixRow[], key: MatrixSortKey, dir: "asc" | "desc"): MatrixRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const value = (r: MatrixRow): number | null =>
    key === "mean" ? r.mean : key === "best" ? r.best : key.startsWith("model:") ? (r.cells[key.slice(6)]?.passRate ?? null) : null;
  return [...rows].sort((a, b) => {
    if (key === "name") return sign * a.name.localeCompare(b.name);
    const va = value(a), vb = value(b);
    if (va === null && vb === null) return b.mean - a.mean || a.name.localeCompare(b.name);
    if (va === null) return 1;
    if (vb === null) return -1;
    return sign * (va - vb) || b.mean - a.mean || a.name.localeCompare(b.name);
  });
}
