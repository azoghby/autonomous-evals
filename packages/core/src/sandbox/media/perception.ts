/**
 * Perception + latency graders (plan §7, §10).
 *  - perception: did the agent's tool args and/or replies carry the ground-truth values it should have read (image)
 *    or heard (voice)? Deterministic, ground-truth-sourced, reward-bearing.
 *  - latency: time to first audio and turn latency p50/p95 from per-turn timestamps. Diagnostic unless a budget is set.
 */
import type { CheckResult, MediaAttachment, ToolCallRecord } from "../spec";
import { textContainsValue } from "./match";

type Severity = CheckResult["severity"];

export interface PerceptionTarget {
  /** Stable check id suffix, e.g. "att1.total". */
  id: string;
  value: string;
  /** Where the value must show up. `tool_args` = in some tool call's args (optionally a specific tool). */
  where: "tool_args" | "reply" | "either";
  tool?: string;
  severity: Severity;
  description?: string;
}

export interface PerceptionInput {
  targets: PerceptionTarget[];
  toolCalls: ToolCallRecord[];
  transcript: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
}

/** Default targets: every ground-truth value of every attachment, found anywhere (tool args or replies), severity high. */
export function targetsFromAttachments(attachments: MediaAttachment[], severity: Severity = "high"): PerceptionTarget[] {
  return attachments.flatMap((a) =>
    Object.entries(a.groundTruth).map(([key, value]) => ({ id: `${a.id}.${key}`, value, where: "either" as const, severity, description: `${a.kind} ${a.id} ${key}` })),
  );
}

/** Voice: facts the persona speaks (e.g. order number, email) become targets the agent must capture in tool args. */
export function targetsFromSpokenFacts(facts: Record<string, string>, opts: { tool?: string; severity?: Severity } = {}): PerceptionTarget[] {
  return Object.entries(facts).map(([key, value]) => ({ id: `voice.${key}`, value, where: "tool_args" as const, tool: opts.tool, severity: opts.severity ?? "high" }));
}

function argsText(call: ToolCallRecord): string {
  return typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? null);
}

export function gradePerception(input: PerceptionInput): CheckResult[] {
  const replies = input.transcript.filter((t) => t.role === "assistant").map((t) => t.content);
  return input.targets.map((t) => {
    const calls = input.toolCalls.filter((c) => !t.tool || c.tool === t.tool);
    const inArgs = calls.filter((c) => textContainsValue(argsText(c), t.value)).map((c) => `${c.tool}#${c.seq}`);
    const inReply = replies.some((r) => textContainsValue(r, t.value));
    const passed = t.where === "tool_args" ? inArgs.length > 0 : t.where === "reply" ? inReply : inArgs.length > 0 || inReply;
    const seen = [inArgs.length ? `tool args (${inArgs.join(", ")})` : "", inReply ? "reply" : ""].filter(Boolean).join(" + ") || "nowhere";
    const scope = t.where === "tool_args" ? `tool args${t.tool ? ` of ${t.tool}` : ""}` : t.where === "reply" ? "agent replies" : "tool args or replies";
    return {
      id: `perception.${t.id}`,
      kind: "perception" as const,
      passed,
      severity: t.severity,
      detail: `${t.description ?? t.id}: expected ${JSON.stringify(t.value)} in ${scope}; found in ${seen}.`,
    };
  });
}

/* ---------------- latency ---------------- */

/** Millisecond timestamps (any monotonic origin) for one user→agent turn. */
export interface TurnTiming {
  turn: number;
  /** User finished speaking / sending. */
  userEndMs: number;
  agentFirstAudioMs?: number;
  agentFirstTokenMs?: number;
  agentEndMs?: number;
}

export interface LatencyStats {
  turns: number;
  ttfaMs: { p50: number; p95: number; max: number } | null;
  turnLatencyMs: { p50: number; p95: number; max: number } | null;
}

export interface LatencyBudget { ttfaP95Ms?: number; turnP50Ms?: number; turnP95Ms?: number; severity?: Severity }

/** Nearest-rank percentile on a copy (input not mutated). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

function summary(xs: number[]): { p50: number; p95: number; max: number } | null {
  return xs.length ? { p50: percentile(xs, 50), p95: percentile(xs, 95), max: Math.max(...xs) } : null;
}

export function latencyStats(timings: TurnTiming[]): LatencyStats {
  const ttfa = timings.filter((t) => t.agentFirstAudioMs !== undefined).map((t) => t.agentFirstAudioMs! - t.userEndMs);
  const turn = timings
    .map((t) => (t.agentFirstAudioMs ?? t.agentFirstTokenMs ?? t.agentEndMs) !== undefined ? (t.agentFirstAudioMs ?? t.agentFirstTokenMs ?? t.agentEndMs)! - t.userEndMs : undefined)
    .filter((x): x is number => x !== undefined);
  if ([...ttfa, ...turn].some((x) => x < 0)) throw new Error("latencyStats: agent timestamp precedes user end (clock origin mismatch?)");
  return { turns: timings.length, ttfaMs: summary(ttfa), turnLatencyMs: summary(turn) };
}

/** One "latency" CheckResult per budgeted metric; with no budget, a single passing diagnostic check carrying the stats. */
export function gradeLatency(timings: TurnTiming[], budget: LatencyBudget = {}): { stats: LatencyStats; checks: CheckResult[] } {
  const stats = latencyStats(timings);
  const sev = budget.severity ?? "medium";
  const fmt = (s: LatencyStats["ttfaMs"]) => (s ? `p50 ${s.p50}ms, p95 ${s.p95}ms, max ${s.max}ms` : "n/a");
  const checks: CheckResult[] = [];
  const add = (id: string, label: string, actual: number | undefined, limit: number) =>
    checks.push({
      id: `latency.${id}`,
      kind: "latency",
      passed: actual !== undefined && actual <= limit,
      severity: sev,
      detail: `${label} ${actual === undefined ? "unmeasured" : `${actual}ms`} vs budget ${limit}ms (${stats.turns} turns).`,
    });
  if (budget.ttfaP95Ms !== undefined) add("ttfa_p95", "time-to-first-audio p95", stats.ttfaMs?.p95, budget.ttfaP95Ms);
  if (budget.turnP50Ms !== undefined) add("turn_p50", "turn latency p50", stats.turnLatencyMs?.p50, budget.turnP50Ms);
  if (budget.turnP95Ms !== undefined) add("turn_p95", "turn latency p95", stats.turnLatencyMs?.p95, budget.turnP95Ms);
  if (checks.length === 0) {
    checks.push({ id: "latency.summary", kind: "latency", passed: true, severity: "low", detail: `TTFA ${fmt(stats.ttfaMs)}; turn ${fmt(stats.turnLatencyMs)} (no budget set; diagnostic).` });
  }
  return { stats, checks };
}
