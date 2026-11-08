import type { Severity } from "../contract";
import type { ChipTone } from "@/components/ui";

export const SEVERITY_TONE: Record<Severity, ChipTone> = { critical: "danger", high: "danger", medium: "warn", low: "muted" };

export const compactJson = (v: unknown): string => {
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

export const prettyJson = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
};

export const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
};

export const ATTRIBUTION_LABEL: Record<string, string> = {
  agent: "Agent fault",
  simulator: "Simulator fault",
  environment: "Environment fault",
  grader: "Grader fault",
  unknown: "Unattributed",
};

/** Non-agent attributions are excluded from your agent's score. */
export const isAgentFault = (a: string | undefined): boolean => a === "agent" || a === "unknown";

export function findClause(policies: ReadonlyArray<{ id: string; title: string; clauses: ReadonlyArray<{ id: string; text: string }> }>, ref?: string) {
  if (!ref) return null;
  for (const p of policies) {
    const c = p.clauses.find((x) => x.id === ref);
    if (c) return { id: c.id, text: c.text, doc: p.title };
  }
  return null;
}
