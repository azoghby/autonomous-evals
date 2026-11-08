import { OVERAGE_CENTS_PER_TRIAL, PLANS, PLAN_ORDER, formatUsd, type PlanId } from "@ae/core/pricing/plans";

/** A cell: true = included, false = not included, string = text, { text, soon } = text flagged "coming soon". */
export type Cell = boolean | string | { text: string; soon: true };
export interface ComparisonRow { label: string; soon?: boolean; cells: Record<PlanId, Cell> }

const num = (n: number | null) => (n == null ? "Custom" : n.toLocaleString("en-US"));
const row = (label: string, d: Cell, p: Cell, s: Cell, e: Cell, soon?: boolean): ComparisonRow => ({
  label, soon, cells: { developer: d, pro: p, scale: s, enterprise: e },
});
const fromPlans = (label: string, pick: (id: PlanId) => Cell): ComparisonRow => ({
  label,
  cells: Object.fromEntries(PLAN_ORDER.map((id) => [id, pick(id)])) as Record<PlanId, Cell>,
});

export const COMPARISON_ROWS: ComparisonRow[] = [
  fromPlans("Environments", (id) => num(PLANS[id].limits.environments)),
  fromPlans("Trials / month", (id) => num(PLANS[id].limits.trialsPerMonth)),
  fromPlans("Overage", (id) => {
    if (id === "enterprise") return "Volume pricing";
    return PLANS[id].limits.overageAllowed ? `${formatUsd(OVERAGE_CENTS_PER_TRIAL)} / trial` : "Hard cap, runs stop";
  }),
  row("pass^k reports with confidence intervals", false, true, true, true),
  row("CI (GitHub Action)", false, true, true, true),
  row("MCP server + REST API", true, true, true, true),
  row("Voice + vision scenarios", false, true, true, true),
  row("Red-team packs", false, false, true, true),
  row("Sample worlds", true, true, true, true),
  row("Custom environments", false, true, true, true),
  row("We build your environment", false, false, false, true),
  row("Domain-expert reviewers", false, false, false, true),
  row("Dedicated Neon project", false, false, { text: "Included", soon: true }, { text: "Included", soon: true }, true),
  row("Priority runs", false, false, true, true),
  fromPlans("Support channel", (id) => (id === "scale" ? { text: "Email (Slack soon)", soon: true } : PLANS[id].support)),
  row("Security review", false, false, false, { text: "Planned", soon: true }, true),
];
