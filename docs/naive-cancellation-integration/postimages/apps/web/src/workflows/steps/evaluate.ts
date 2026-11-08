import { assertWorkflowStageCurrent } from "@/server/workflow-stage-runtime";
import { summarizeRunResults } from "@ae/core/contracts/services";
import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { FatalError } from "workflow";
import type { Finding, Remediation, Report, Suite } from "@ae/core/contracts/index";
import type { RunResult } from "@ae/core/contracts/services";
import { appendRedTeamToSuite } from "@ae/core/redteam/index";
import { putJobArtifact } from "@ae/core/storage/blob";
import { findingRowIdByKey, recordProgress, saveFindings, saveRemediation, setJobState } from "@/server/job-store";
import { resolveBranchConnection } from "@/server/branch-connection";
import { getEvalServices, isWorkflowStageControlError, isWorkflowStagePendingError, recoverableEvalStage, workflowServiceCall } from "@/server/services";
import { loadIntake, requireJob, withBudget, type BudgetResult } from "./common";

/** Feature flag: on by default; REDTEAM_PACK=0|false|off|no disables. */
function redTeamPackEnabled(): boolean {
  return !/^(0|false|off|no)$/i.test(process.env.REDTEAM_PACK ?? "");
}

type EndpointSlot = "endpoint" | "endpointA" | "endpointB";

export async function auditTraceStep(jobId: string): Promise<BudgetResult<Finding[]>> {
  "use step";
  const intake = await loadIntake(jobId, false);
  if (intake.package !== "trace_audit") throw new FatalError("auditTrace requires a trace_audit job");
  const {services, stage} = await recoverableEvalStage("auditTrace", jobId, "trace-audit", intake);
  const result = await workflowServiceCall(() => withBudget(jobId, "investigator", stage, async (ctx) => {
    await ctx.recordProgress("auditing_trace", "Checking the trace for unsupported claims, ignored errors, and instruction violations.");
    const audit = await services.auditTrace(ctx, intake.trace, intake.systemPrompt);
    return audit.findings;
  }));
  if (result.status === "ok") await recordProgress(jobId, "trace_audited", `Trace audit found ${result.data.length} finding(s).`);
  return result;
}
// Allow retained-session polling and expired-owner recovery; stage admission prevents fresh callback replay.
auditTraceStep.maxRetries = 120;

/** Creates the per-job Neon branch. Returns only the branch id: step I/O is persisted in plaintext, so the connection string is never returned. */
export async function createBranchStep(jobId: string): Promise<{ branchId: string }> {
  "use step";
  const services = await getEvalServices();
  const job = await requireJob(jobId);
  // A previous attempt that wrote neon_branch_id but lost its result is simply recreated.
  if (job.neonBranchId) await services.deleteJobBranch(job.neonBranchId);
  const branch = await services.createJobBranch(jobId);
  await setJobState(jobId, job.state, { neonBranchId: branch.branchId });
  await recordProgress(jobId, "branch_ready", "Isolated test environment created.");
  return { branchId: branch.branchId };
}

export async function designSuiteStep(jobId: string): Promise<BudgetResult<Suite>> {
  "use step";
  const intake = await loadIntake(jobId, false);
  const services = await getEvalServices();
  const result = await withBudget(jobId, "engineer", {key: "suite-design", input: {intake, redTeam: redTeamPackEnabled()}}, async (ctx) => {
    const designed = await services.designSuite(ctx, intake);
    // Red-team pack (rt_* scenarios): pure + free, so it does not touch the budget. Disable with REDTEAM_PACK=off.
    const suite = redTeamPackEnabled() ? appendRedTeamToSuite(designed, intake) : designed;
    await assertWorkflowStageCurrent();
    const path = await putJobArtifact(jobId, "suite", JSON.stringify(suite), "application/json");
    const job = await requireJob(jobId);
    await assertWorkflowStageCurrent();
    await setJobState(jobId, job.state, { suiteBlobPath: path });
    return suite;
  });
  if (result.status === "ok") {
    await recordProgress(jobId, "suite_frozen", `Test suite frozen: ${result.data.scenarios.length} scenario(s).`);
  }
  return result;
}
designSuiteStep.maxRetries = 1;

function targetFor(intake: Awaited<ReturnType<typeof loadIntake>>, slot: EndpointSlot) {
  const ep = (intake as unknown as Record<string, { url: string; model: string; apiKey?: string; systemPrompt?: string } | undefined>)[slot];
  if (!ep) throw new FatalError(`Job intake has no ${slot}`);
  return { url: ep.url, model: ep.model, apiKey: ep.apiKey, systemPrompt: ep.systemPrompt ?? "" };
}

/** Runs the frozen suite against one target version. Credentials are loaded here and never leave the step. */
export async function runSuiteStep(
  jobId: string, suite: Suite, slot: EndpointSlot, versionLabel: string, branchId?: string,
): Promise<BudgetResult<RunResult>> {
  "use step";
  const intake = await loadIntake(jobId, true);
  const target = targetFor(intake, slot);
  if (!target.apiKey) {
    const [cred] = await db().select({ id: schema.jobCredentials.jobId }).from(schema.jobCredentials).where(eq(schema.jobCredentials.jobId, jobId)).limit(1);
    if (!cred && Array.isArray((intake as unknown as { _credentialSlots?: unknown })._credentialSlots)) {
      throw new FatalError("Target credentials were deleted before the run");
    }
  }
  const services = await getEvalServices();
  const branchConnectionString = branchId ? await resolveBranchConnection(branchId) : undefined;
  const result = await withBudget(jobId, "judge", {key: `suite-run:${slot}:${versionLabel}`, input: {suite, slot, versionLabel, branchId, target}}, async (ctx) => {
    await ctx.recordProgress("running_suite", `Running ${suite.scenarios.length} scenario(s) against ${versionLabel}.`);
    return services.runSuite(ctx, { ...suite, versionLabel }, target, branchConnectionString);
  });
  if (result.status === "ok") {
    const counts = summarizeRunResults(result.data.results);
    await recordProgress(jobId, "suite_run", `Run ${versionLabel} complete: ${counts.passed} objective passed, ${counts.failed} objective failed, ${counts.rubric} rubric, ${counts.inconclusive} inconclusive, ${counts.infrastructure} infrastructure.`);
  }
  return result;
}
runSuiteStep.maxRetries = 1;

export async function investigateStep(jobId: string, suite: Suite, runs: RunResult[]): Promise<BudgetResult<Finding[]>> {
  "use step";
  const services = await getEvalServices();
  const result = await withBudget(jobId, "investigator", {key: "investigation", input: {suite, runs}}, (ctx) => services.investigate(ctx, suite, runs));
  if (result.status === "ok") await recordProgress(jobId, "investigated", `Investigation produced ${result.data.length} finding(s).`);
  return result;
}
investigateStep.maxRetries = 1;

/** Proposes and verifies a fix. Only definitive service failures become a null result.
 * Pending work retains the mixed callback's parent hold; it never enables automatic replay.
 * Publication and ownership failures escape the semantic service-failure catch.
 */
export async function proposeFixStep(jobId: string, finding: Finding, suite?: Suite): Promise<BudgetResult<Remediation | null>> {
  "use step";
  const intake = await loadIntake(jobId, false);
  const services = await getEvalServices();
  return workflowServiceCall(() => withBudget(jobId, "engineer", {
    key: `remediation:${finding.id}`, input: {finding, suite, intake},
    isPendingError: isWorkflowStagePendingError,
  }, async (ctx) => {
    await ctx.recordProgress("proposing_fix", `Proposing and verifying a fix for "${finding.title.slice(0, 120)}".`);
    let fix: Remediation;
    try {
      fix = await services.proposeAndVerifyFix(ctx, { finding, suite, intake });
    } catch (err) {
      if (isWorkflowStageControlError(err)) throw err;
      await assertWorkflowStageCurrent();
      await ctx.recordProgress("fix_failed", `Could not verify a fix for finding ${finding.id}.`);
      return null;
    }
    await assertWorkflowStageCurrent();
    await saveFindings(jobId, [finding]);
    const rowId = await findingRowIdByKey(jobId, finding.id);
    if (!rowId) throw new Error("finding row missing");
    await assertWorkflowStageCurrent();
    await saveRemediation(jobId, rowId, fix);
    return fix;
  }));
}
proposeFixStep.maxRetries = 1;

export async function renderReportStep(jobId: string, findings: Finding[], suite?: Suite, remediations?: Remediation[]): Promise<BudgetResult<Report>> {
  "use step";
  const intake = await loadIntake(jobId, false);
  const {services, stage} = await recoverableEvalStage("renderReport", jobId, "report", {intake, findings, suite, remediations});
  return workflowServiceCall(() => withBudget(jobId, "operator", stage, (ctx) => services.renderReport(ctx, { intake, findings, suite, remediations })));
}
// Allow retained-session polling and expired-owner recovery; stage admission prevents fresh callback replay.
renderReportStep.maxRetries = 120;

/** Writes report, evidence, and findings to Blob + Neon. Safe to retry: findings are keyed, blobs get random suffixes. */
export async function persistReportStep(jobId: string, report: Report, suite?: Suite): Promise<void> {
  "use step";
  return persistReport(jobId,report,suite);
}

/** Non-step helper preserves the current server stage scope for authoritative SQL publication.
 * Blob writes precede their fenced SQL references; failed ownership may leave private orphan blobs. */
export async function persistReport(jobId:string,report:Report,suite?:Suite):Promise<void> {
  const markdownPath = await putJobArtifact(jobId, "report", report.markdown, "text/markdown");
  await putJobArtifact(jobId, "report-html", report.html, "text/html");
  await putJobArtifact(jobId, "evidence", JSON.stringify(report.findings.map((f) => ({ id: f.id, evidence: f.evidence }))), "application/json");
  const extra: { reportBlobPath: string; suiteBlobPath?: string } = { reportBlobPath: markdownPath };
  if (suite) extra.suiteBlobPath = await putJobArtifact(jobId, "suite", JSON.stringify(suite), "application/json");
  await saveFindings(jobId, report.findings);
  const job = await requireJob(jobId);
  await setJobState(jobId, job.state, extra);
  await recordProgress(jobId, "report_stored", "Report and evidence stored.");
}
