/** Pure status helpers (no I/O): overall level, staleness classification, relative-age formatting. */

export type StatusLevel = "operational" | "degraded" | "down";
export type ProbeLevel = "ok" | "degraded" | "down";

export interface Probe {
  id: string;
  label: string;
  /** A critical probe that is "down" takes the whole service down; otherwise it only degrades it. */
  critical: boolean;
  level: ProbeLevel;
  latencyMs: number | null;
  /** Human-readable reasons the probe is not "ok" (never contains secrets). */
  notes: string[];
  /** Error class name when the probe threw or timed out. */
  errorClass: string | null;
}

export interface OverallStatus {
  level: StatusLevel;
  label: string;
  reasons: string[];
}

const LEVEL_LABEL: Record<StatusLevel, string> = {
  operational: "All systems operational",
  degraded: "Partially degraded",
  down: "Major outage",
};

/** Overall level: a critical probe that is down => down; any non-ok probe => degraded; else operational. */
export function summarizeStatus(probes: readonly Probe[]): OverallStatus {
  const reasons: string[] = [];
  let level: StatusLevel = "operational";
  for (const p of probes) {
    if (p.level === "ok") continue;
    const why = p.errorClass ? `${p.label} failed (${p.errorClass})` : p.notes[0] ? `${p.label}: ${p.notes[0]}` : `${p.label} ${p.level}`;
    reasons.push(why);
    if (p.level === "down" && p.critical) level = "down";
    else if (level !== "down") level = "degraded";
  }
  return { level, label: LEVEL_LABEL[level], reasons };
}

export const STALE_RUNNING_MS = 30 * 60_000;

const toMs = (v: Date | string | number) => (v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v));

/** True when a running item has had no update for longer than the threshold (default 30 min). */
export function isStaleRunning(updatedAt: Date | string | number, now: Date | number, thresholdMs = STALE_RUNNING_MS): boolean {
  return toMs(now) - toMs(updatedAt) > thresholdMs;
}

/** Compact relative age, e.g. "just now", "42s ago", "5m ago", "3h ago", "2d ago". */
export function formatAge(from: Date | string | number | null | undefined, now: Date | number): string {
  if (from == null) return "never";
  const t = toMs(from);
  if (Number.isNaN(t)) return "unknown";
  const s = Math.floor((toMs(now) - t) / 1000);
  if (s < 0) return "in the future";
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Approximate interval between runs of a 5-field cron expression. Handles the shapes in vercel.json:
 * every-N-minutes, hourly, and daily. Returns null if it cannot tell.
 */
export function cronIntervalMs(schedule: string): number | null {
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  const step = /^\*\/(\d+)$/.exec(min);
  if (step && hour === "*" && dom === "*" && mon === "*" && dow === "*") return Number(step[1]) * 60_000;
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return 60 * 60_000;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow === "*") return 24 * 60 * 60_000;
  return null;
}

export type ActivityState = "recent" | "quiet" | "none";

/**
 * Classifies last recorded activity relative to the cron cadence: "recent" within 2.5 intervals (plus 5 min
 * slack), otherwise "quiet". "none" when nothing was ever recorded. Never "failed": the absence of a row can
 * also mean there was nothing to do.
 */
export function classifyActivity(lastAt: Date | string | number | null | undefined, intervalMs: number | null, now: Date | number): ActivityState {
  if (lastAt == null) return "none";
  if (intervalMs == null) return "recent";
  return toMs(now) - toMs(lastAt) <= intervalMs * 2.5 + 5 * 60_000 ? "recent" : "quiet";
}

/** Short cadence label for a cron schedule, e.g. "every 15m", "hourly", "daily 09:00 UTC". */
export function describeCron(schedule: string): string {
  const f = schedule.trim().split(/\s+/);
  const ms = cronIntervalMs(schedule);
  if (ms == null) return schedule;
  if (ms < 60 * 60_000) return `every ${ms / 60_000}m`;
  if (ms === 60 * 60_000) return "hourly";
  const pad = (n: string) => n.padStart(2, "0");
  return `daily ${pad(f[1])}:${pad(f[0])} UTC`;
}
