/**
 * Company operator: customer-facing report summary. Optional; the report renders without it.
 * The summary may only reference finding IDs that exist and must not mention off-menu prices.
 */
import { z } from "zod";
import { findInventedPrices } from "../evals/pricing";
import type { Finding, JobRef } from "../evals/types";
import { TASK_BUDGETS } from "./roles";
import type { AgentServiceOutcome } from "./commercial";
import type { AgentTaskRunner } from "./session-service";

export const ReportSummaryOutput = z.object({
  executive_summary: z.string().min(1).max(1500),
  finding_notes: z.array(z.object({ finding_id: z.string().max(20), note: z.string().min(1).max(500) })).max(40),
  recommended_next_steps: z.array(z.string().min(1).max(300)).max(5),
  retest_recommended: z.boolean(),
});
export type ReportSummaryOutput = z.infer<typeof ReportSummaryOutput>;

export interface OperatorSummary extends ReportSummaryOutput {
  /** Always shown to the customer next to the summary. */
  authorship: "agent_written";
}

const FORBIDDEN = /\b(profit|revenue|statistically significant|p-value|guarantee[ds]?)\b/i;

export async function writeReportSummary(
  args: { job: JobRef; findings: Finding[]; limitations: string[]; budgetMicroUsd?: number },
  runner: AgentTaskRunner,
): Promise<AgentServiceOutcome<OperatorSummary>> {
  const data = {
    package: args.job.package,
    findings: args.findings.map((f) => ({ finding_id: f.id, label: f.label, severity: f.severity, category: f.category, title: f.title, summary: f.summary.slice(0, 600) })),
    limitations: args.limitations,
  };
  const outcome = await runner.run({
    job: args.job,
    role: "company_operator",
    purpose: "report_summary",
    message: `Task: write the customer-facing summary for a finished evaluation.
Use only the findings below. Keep their labels exactly (confirmed / rubric concern / inconclusive). If there are no findings, say no problems were found in what was examined and restate the limitations. Do not add numbers, prices, statistics, or claims not present in the input.
<untrusted_data>
${JSON.stringify(data, null, 1).replace(/</g, "\\u003c")}
</untrusted_data>`,
    output: { name: "report_summary.v1", schema: ReportSummaryOutput },
    budgetMicroUsd: args.budgetMicroUsd ?? TASK_BUDGETS.reportSummary,
  });
  if (outcome.status !== "completed") return outcome;
  const o = outcome.output;
  const ids = new Set(args.findings.map((f) => f.id));
  const unknown = o.finding_notes.filter((n) => !ids.has(n.finding_id)).map((n) => n.finding_id);
  const allText = [o.executive_summary, ...o.finding_notes.map((n) => n.note), ...o.recommended_next_steps].join("\n");
  const problems = [
    ...(unknown.length ? [`references unknown findings ${unknown.join(", ")}`] : []),
    ...(findInventedPrices(allText).length ? ["mentions prices not on the menu"] : []),
    ...(FORBIDDEN.test(allText) ? ["uses a forbidden claim (profit/revenue/significance/guarantee)"] : []),
  ];
  if (problems.length) {
    return { status: "failed", taskKey: outcome.taskKey, code: "summary_policy_violation", message: problems.join("; "), session: outcome.session, cost: outcome.cost };
  }
  return { status: "completed", taskKey: outcome.taskKey, cost: outcome.cost, value: { ...o, authorship: "agent_written" } };
}
