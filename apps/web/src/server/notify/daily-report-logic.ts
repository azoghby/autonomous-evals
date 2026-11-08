/** Pure daily-report formatting + recommended actions. Tested in daily-report-logic.test.ts. */

export interface DailyMetrics {
  since: Date;
  revenue: { liveCents: number; testCents: number; livePurchases: number; testPurchases: number };
  signups: number;
  runs: { started: number; completed: number; failed: number; avgPassRate: number | null };
  spend: { totalMicroUsd: number; dailyBudgetMicroUsd: number | null; publicAgentMicroUsd: number; publicAgentBudgetMicroUsd: number };
  pending: { approvals: number; outreachDrafts: number; newLeads: number };
  failures: { failedJobs: number; pausedJobs: number; paymentReview: number };
  /** Optional: the company CEO planner's plan for the day (bullet lines), when that agent exists. */
  plan?: string[];
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const usdMicro = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Top 3 actions, highest leverage first. Deterministic: same metrics, same advice. */
export function recommendActions(m: DailyMetrics): string[] {
  const out: string[] = [];
  if (m.failures.paymentReview > 0) out.push(`Resolve ${m.failures.paymentReview} payment(s) in review (refund or resume) in /operator.`);
  if (m.pending.approvals > 0) out.push(`Clear ${m.pending.approvals} pending approval(s): reply YES/NO here or use /operator > Notifications.`);
  if (m.pending.newLeads > 0) out.push(`Contact ${m.pending.newLeads} new enterprise lead(s) today (speed wins deals).`);
  if (m.failures.failedJobs + m.failures.pausedJobs > 0) out.push(`Look at ${m.failures.failedJobs} failed / ${m.failures.pausedJobs} budget-paused job(s).`);
  if (m.spend.dailyBudgetMicroUsd && m.spend.totalMicroUsd > 0.8 * m.spend.dailyBudgetMicroUsd) out.push(`Spend is at ${pct(m.spend.totalMicroUsd / m.spend.dailyBudgetMicroUsd)} of the daily budget; check costs by source.`);
  if (m.runs.avgPassRate !== null && m.runs.avgPassRate < 0.5 && m.runs.completed >= 3) out.push(`Average pass rate is ${pct(m.runs.avgPassRate)}; spot-check findings for false positives.`);
  if (m.pending.outreachDrafts > 0 && m.pending.approvals === 0) out.push(`Review ${m.pending.outreachDrafts} outreach draft(s) waiting in /operator.`);
  if (m.revenue.liveCents === 0 && m.signups > 0) out.push(`${m.signups} signup(s) but no live revenue: follow up with them personally.`);
  if (m.signups === 0 && m.revenue.liveCents === 0) out.push("No signups or revenue in 24h: send a few agent invites or post a leaderboard result.");
  return out.slice(0, 3);
}

/** Phone-sized plain text (fits one Telegram/WhatsApp message). */
export function formatDailyReport(m: DailyMetrics, operatorUrl: string): string {
  const budget = m.spend.dailyBudgetMicroUsd ? ` of ${usdMicro(m.spend.dailyBudgetMicroUsd)} budget` : "";
  const lines = [
    "Standard Evals: daily report (last 24h)",
    "",
    `Revenue: ${usd(m.revenue.liveCents)} live (${m.revenue.livePurchases}) | ${usd(m.revenue.testCents)} test (${m.revenue.testPurchases})`,
    `Signups: ${m.signups}`,
    `Runs: ${m.runs.started} started, ${m.runs.completed} completed${m.runs.avgPassRate !== null ? `, avg pass ${pct(m.runs.avgPassRate)}` : ""}${m.runs.failed ? `, ${m.runs.failed} failed` : ""}`,
    `Spend: ${usdMicro(m.spend.totalMicroUsd)}${budget}; public agents ${usdMicro(m.spend.publicAgentMicroUsd)} of ${usdMicro(m.spend.publicAgentBudgetMicroUsd)}`,
    `Pending: ${m.pending.approvals} approvals, ${m.pending.outreachDrafts} drafts, ${m.pending.newLeads} new leads`,
    `Failures: ${m.failures.failedJobs} failed, ${m.failures.pausedJobs} paused on budget, ${m.failures.paymentReview} payment review`,
  ];
  if (m.plan?.length) lines.push("", "Today's plan (CEO agent):", ...m.plan.slice(0, 5).map((p) => `- ${p}`));
  const actions = recommendActions(m);
  if (actions.length) lines.push("", "Top actions:", ...actions.map((a, i) => `${i + 1}. ${a}`));
  lines.push("", `Console: ${operatorUrl}`);
  return lines.join("\n");
}

/** Mean of finite rates in [0,1]; null when there are none. */
export function meanRate(rates: Array<number | null | undefined>): number | null {
  const xs = rates.filter((r): r is number => typeof r === "number" && Number.isFinite(r) && r >= 0 && r <= 1);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
