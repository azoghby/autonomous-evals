/** Pure helpers for the eval copilot UI (formatting, selection, parsing). No React, no DOM: unit-tested in format.test.ts. */
import type { ActionResult, ActionStatus, EvalKind, TimelineStep } from "@/lib/eval-chat/types";
import type { DraftScenario } from "../sandbox/contract";

export const MIN_PANEL_WIDTH = 360;
export const MAX_PANEL_WIDTH = 720;
export const DEFAULT_PANEL_WIDTH = 440;
export const MAX_MESSAGE_LENGTH = 4000;
export const COUNTER_THRESHOLD = 3500;

export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
export const clampPanelWidth = (w: number): number => (Number.isFinite(w) ? clamp(Math.round(w), MIN_PANEL_WIDTH, MAX_PANEL_WIDTH) : DEFAULT_PANEL_WIDTH);

/** 0.8333 -> "83%". Null/NaN -> an en dash. */
export const pct = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? "–" : `${Math.round(n * 100)}%`);

export const usd = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return "–";
  if (n === 0) return "$0.00";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
};

export const ratio = (passed: number, total: number): string => `${passed}/${total}`;

export const KIND_LABEL: Record<EvalKind, string> = { sandbox_run: "Sandbox run", job: "Audit" };

export function relativeDate(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** Position (0-100) of a 0-1 value on a track. */
export const trackPos = (v: number): number => clamp(v, 0, 1) * 100;

/** CI band as left/width percentages; tolerates reversed or out-of-range bounds. */
export function ciBand(ci: readonly [number, number]): { left: number; width: number } {
  const lo = trackPos(Math.min(ci[0], ci[1]));
  const hi = trackPos(Math.max(ci[0], ci[1]));
  return { left: lo, width: Math.max(hi - lo, 0.5) };
}

export const progressPct = (done: number, total: number): number => (total > 0 ? clamp(Math.round((done / total) * 100), 0, 100) : 0);

/** Scenarios in a draft that are not part of the base run: these are the ones the copilot just added. */
export function newScenarios(scenarios: readonly DraftScenario[], baseScenarioIds: readonly string[]): DraftScenario[] {
  const base = new Set(baseScenarioIds);
  return scenarios.filter((s) => !base.has(s.scenario.id));
}

/** Persona goal if present, else name, else null. Defensive: the persona comes from generated JSON. */
export function personaLabel(persona: unknown): string | null {
  if (!persona || typeof persona !== "object") return null;
  const p = persona as { goal?: unknown; name?: unknown };
  if (typeof p.goal === "string" && p.goal.trim()) return p.goal.trim();
  if (typeof p.name === "string" && p.name.trim()) return p.name.trim();
  return null;
}

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/** Keys whose value differs between before and after (missing on one side counts as changed). Sorted union order: before keys then new after keys. */
export function changedKeys(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[] {
  const b = before ?? {};
  const a = after ?? {};
  const keys = [...Object.keys(b), ...Object.keys(a).filter((k) => !(k in b))];
  return keys.filter((k) => !(k in b) || !(k in a) || !same(b[k], a[k]));
}

export const cellText = (v: unknown): string => {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

export const orderTimeline = (steps: readonly TimelineStep[]): TimelineStep[] => [...steps].sort((a, b) => a.seq - b.seq);

/** Latest known status: server action result wins over the status baked into the tool output; unresolved cards past expiry read as expired. */
export function effectiveStatus(card: { status: ActionStatus; expiresAt: string }, result: ActionResult | undefined, now: number = Date.now()): ActionStatus {
  const status = result?.status ?? card.status;
  if (status !== "proposed") return status;
  const exp = new Date(card.expiresAt).getTime();
  return !Number.isNaN(exp) && exp < now ? "expired" : status;
}

/* ---------------- inline text ---------------- */

export type Inline = { type: "text" | "bold" | "code"; value: string };

/** Split a paragraph into text / **bold** / `code` runs. Everything is rendered as React text, never HTML. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*\n]+?)\*\*|`([^`\n]+?)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { type: "bold", value: m[1] } : { type: "code", value: m[2] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

export const splitParagraphs = (text: string): string[] =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

export const hasVisibleText = (text: string): boolean => text.trim().length > 0;

export const CHANGE_TONE = { fixed: "ok", regressed: "danger", same: "muted", added: "accent", removed: "warn" } as const;

/* ---------------- labels and summaries ---------------- */

/** "policy_conflict" -> "Policy conflict". */
export const humanize = (s: string): string => {
  const t = s.replace(/[_-]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
};

export type Tone = "ok" | "danger" | "warn" | "accent" | "muted";

export function severityTone(severity: string): Tone {
  const s = severity.toLowerCase();
  if (s === "critical" || s === "high") return "danger";
  if (s === "medium") return "warn";
  return "muted";
}

export const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;

export const ATTRIBUTION_TEXT: Record<string, string> = {
  agent: "Agent fault",
  simulator: "Simulator fault",
  environment: "Environment fault",
  grader: "Grader fault",
  unknown: "Unattributed",
};
export const attributionText = (a: string): string => ATTRIBUTION_TEXT[a] ?? humanize(a);

/** pass@1 as the mean scenario pass rate; pass^k as the share of scenarios where every trial passed. */
export function summarizeResults(results: ReadonlyArray<{ passRate: number; reliable: boolean }>): { passAt1: number; passHatK: number } | null {
  if (results.length === 0) return null;
  const passAt1 = results.reduce((sum, r) => sum + r.passRate, 0) / results.length;
  const passHatK = results.filter((r) => r.reliable).length / results.length;
  return { passAt1, passHatK };
}

export const trialCells = (passed: number, total: number, cap = 24): boolean[] => {
  const n = Math.max(0, Math.min(total, cap));
  return Array.from({ length: n }, (_, i) => i < passed);
};

/** Truncate long text on a character budget, reporting whether anything was cut. */
export function clip(text: string, limit: number): { text: string; clipped: boolean } {
  return text.length > limit ? { text: `${text.slice(0, limit).trimEnd()}…`, clipped: true } : { text, clipped: false };
}
