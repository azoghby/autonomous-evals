import type { DemoScenario, DemoStoryRole, DemoTrial } from "./demo-run-types";

/** Coerce any JSON value to display text without throwing. */
export function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return json(v, false);
}

export function json(v: unknown, pretty = true): string {
  try {
    const s = JSON.stringify(v, null, pretty ? 2 : undefined);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

/** Compact cell value for table rows. */
export function cell(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "-";
  if (typeof v === "string") return v === "" ? '""' : v;
  return str(v);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function usd(n: unknown): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `$${v.toFixed(v >= 1 ? 2 : 4)}`;
}

export function pct(n: unknown): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `${Math.round(v * 100)}%`;
}

export function ms(n: unknown): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

/** Deterministic (UTC) so server and client render the same text. */
export function recordedDate(iso: unknown): string {
  const d = new Date(str(iso));
  if (Number.isNaN(d.getTime())) return str(iso) || "an unknown date";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export const ROLE_LABEL: Record<DemoStoryRole, string> = {
  clean: "Clean pass",
  boundary: "Policy boundary",
  injection: "Prompt injection",
};

export function roleLabel(role: unknown): string {
  return typeof role === "string" && role in ROLE_LABEL ? ROLE_LABEL[role as DemoStoryRole] : str(role) || "Scenario";
}

export function passCount(trials: DemoTrial[] | undefined): number {
  return (trials ?? []).filter((t) => t?.passed).length;
}

export function scenarioPassSummary(s: DemoScenario): { label: string; tone: "ok" | "danger" } {
  // Simulator/environment failures are excluded from scoring, as in the engine's countedTrials().
  const counted = (s.trials ?? []).filter((t) => t.passed || (t.failureAttribution !== "simulator" && t.failureAttribution !== "environment"));
  const n = counted.length;
  const p = passCount(counted);
  return s.reliable
    ? { label: `pass^k · ${p}/${n}`, tone: "ok" }
    : { label: `${p}/${n} passed`, tone: "danger" };
}

export function clamp01(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
