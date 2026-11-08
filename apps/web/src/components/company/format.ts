const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "5 min ago", "3 h ago", "2 d ago". Pure; `now` injected for tests and SSR determinism. */
export function relativeTime(iso: string, now: Date): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Math.max(0, now.getTime() - t);
  if (diff < MIN) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  return `${Math.floor(diff / DAY)} d ago`;
}

/** "leads_found" -> "leads found" */
export const humanizeKey = (k: string): string => k.replace(/_/g, " ");

export const DEPARTMENT_LABEL: Record<string, string> = {
  leadership: "Leadership",
  growth: "Growth",
  customer: "Customer",
  evaluation: "Evaluation",
  operations: "Operations",
};
export const DEPARTMENT_ORDER = ["leadership", "growth", "customer", "evaluation", "operations"] as const;
