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
import { requireNaivePackage, selectedNaiveMethod, selectedNaiveEvaluation, toNaiveWorkflowError } from "@/server/naive-method-routing";
import { makeServiceContext } from "@/server/job-store";
import { createNaiveTextPublication, readNaiveTextDeliveryReceipt, claimNaiveTextDeliveryNotification, completeNaiveTextDeliveryNotification } from "@/server/naive-text-publication";
import { evalServices as naiveReportServices } from "@ae/core/integration/eval-services";
import { getEvalServices } from "@/server/services";
import { notifyCustomerStep } from "./notify";
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
  const services = await getEvalServices();
  const result = await withBudget(jobId, "investigator", async (ctx) => {
    await ctx.recordProgress("auditing_trace", "Checking the trace for unsupported claims, ignored errors, and instruction violations.");
    const audit = await services.auditTrace(ctx, intake.trace, intake.systemPrompt);
    return audit.findings;
  });
  if (result.status === "ok") await recordProgress(jobId, "trace_audited", `Trace audit found ${result.data.length} finding(s).`);
  return result;
}
auditTraceStep.maxRetries = 1;

/** Creates the per-job Neon branch. Returns only the branch id: step I/O is persisted in plaintext, so the connection string is never returned. */
export async function createBranchStep(jobId: string): Promise<{ branchId?: string }> {
  "use step";
  const intake = await loadIntake(jobId, false);
  if (selectedNaiveEvaluation()) {
    requireNaivePackage(intake.package);
    return {}; // text execution has no simulator isolation requirement
  }
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
  const result = await withBudget(jobId, "engineer", async (ctx) => {
    const designed = await services.designSuite(ctx, intake);
    // Red-team pack (rt_* scenarios): pure + free, so it does not touch the budget. Disable with REDTEAM_PACK=off.
    const suite = !selectedNaiveEvaluation() && redTeamPackEnabled() ? appendRedTeamToSuite(designed, intake) : designed;
    const path = await putJobArtifact(jobId, "suite", JSON.stringify(suite), "application/json");
    const job = await requireJob(jobId);
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
  const result = await withBudget(jobId, "judge", async (ctx) => {
    await ctx.recordProgress("running_suite", `Running ${suite.scenarios.length} scenario(s) against ${versionLabel}.`);
    return services.runSuite(ctx, selectedNaiveEvaluation() ? suite : { ...suite, versionLabel }, target, branchConnectionString);
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
  const result = await withBudget(jobId, "investigator", (ctx) => services.investigate(ctx, suite, runs));
  if (result.status === "ok") await recordProgress(jobId, "investigated", `Investigation produced ${result.data.length} finding(s).`);
  return result;
}
investigateStep.maxRetries = 1;

/**
 * Proposes + verifies a fix for one confirmed finding (engineer budget share). Never fails the job:
 * a service error yields data=null and a progress note. The finding row is stored first (idempotent) so the
 * remediation can reference it; persistReportStep later skips already-stored keys.
 */
export async function proposeFixStep(jobId: string, finding: Finding, suite?: Suite): Promise<BudgetResult<Remediation | null>> {
  "use step";
  const intake = await loadIntake(jobId, false);
  const services = await getEvalServices();
  const result = await withBudget(jobId, "engineer", async (ctx) => {
    try {
      await ctx.recordProgress("proposing_fix", `Proposing and verifying a fix for "${finding.title.slice(0, 120)}".`);
      const fix = await services.proposeAndVerifyFix(ctx, { finding, suite, intake });
      await saveFindings(jobId, [finding]);
      const rowId = await findingRowIdByKey(jobId, finding.id);
      if (!rowId) throw new Error("finding row missing");
      await saveRemediation(jobId, rowId, fix);
      return fix;
    } catch (err) {
      if (selectedNaiveMethod("proposeAndVerifyFix")) throw err;
      await ctx.recordProgress("fix_failed", `Could not verify a fix for finding ${finding.id}: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
      return null;
    }
  });
  return result;
}
proposeFixStep.maxRetries = 1;

export async function renderReportStep(jobId: string, findings: Finding[], suite?: Suite, remediations?: Remediation[]): Promise<BudgetResult<Report>> {
  "use step";
  const intake = await loadIntake(jobId, false);
  const services = await getEvalServices();
  return withBudget(jobId, "operator", (ctx) => services.renderReport(ctx, { intake, findings, suite, remediations }));
}
renderReportStep.maxRetries = 1;

/** Writes report, evidence, and findings to Blob + Neon. Safe to retry: findings are keyed, blobs get random suffixes. */
export async function persistReportStep(jobId: string, report: Report, suite?: Suite): Promise<void> {
  "use step";
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

/** Durable Workflow reads configuration inside a step; selected generic text has no verified fix runtime. */
export async function genericTextExecutionPolicyStep(): Promise<boolean> {
  "use step";
  const selected = selectedNaiveEvaluation();
  if (selected && selectedNaiveMethod("proposeAndVerifyFix")) throw new FatalError("Generic Naive remediation requires its own owner runtime.");
  return selected;
}

/** Rich baseline coverage and current retained authority gate generic publication. */
export async function genericTextReportStep(jobId: string, findings: Finding[], suite: Suite): Promise<BudgetResult<{ assessed: boolean; deliveredAtIso?: string }>> {
  "use step";
  const prepared = await withBudget(jobId, "operator", async ctx => {
    const publication = await createNaiveTextPublication(ctx, suite, findings);
    const coverage = await publication.reportContext();
    if (!coverage.assessed) {
      await ctx.recordProgress("naive_no_assessment", "Evaluation has no assessable results; report delivery and settlement are on hold.");
      return null;
    }
    const intake = await loadIntake(jobId, false);
    await publication.assertCurrent({ findings, suite });
    let report: Report;
    try { report = await naiveReportServices.renderReport(ctx, { intake, findings, suite, remediations: [] }); }
    catch (error) { throw toNaiveWorkflowError(error); }
    await publication.assertCurrent(report);
    const escape = (s: string) => s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
    report.markdown += `\n\n## Assessment coverage and limitations\n\n${coverage.summary}\n`;
    report.html += `<section><h2>Assessment coverage and limitations</h2><pre>${escape(coverage.summary)}</pre></section>`;
    report.summary = `${coverage.summary}\n\n${report.summary}`.slice(0, 10000);
    await publication.assertCurrent(report);
    return report;
  });
  if (prepared.status === "budget_exceeded") return prepared;
  if (!prepared.data) return { status: "ok", data: { assessed: false } };
  // Release the paid-stage reservation before atomic publication, so a lost release
  // acknowledgement cannot fail a job after its report has already been delivered.
  const report = prepared.data;
  const publication = await createNaiveTextPublication(await makeServiceContext(jobId), suite, findings);
  await publication.assertCurrent(report);
  const reportBlobPath = await putJobArtifact(jobId, "report", report.markdown, "text/markdown");
  const reportHtmlBlobPath = await putJobArtifact(jobId, "report-html", report.html, "text/html");
  const evidenceBlobPath = await putJobArtifact(jobId, "evidence", JSON.stringify(report.findings.map(f => ({ id: f.id, evidence: f.evidence }))), "application/json");
  const suiteBlobPath = await putJobArtifact(jobId, "suite", JSON.stringify(suite), "application/json");
  await publication.assertCurrent(report);
  const receipt = await publication.atomicPublish(report, { reportBlobPath, reportHtmlBlobPath, evidenceBlobPath, suiteBlobPath });
  return { status: "ok", data: { assessed: true, deliveredAtIso: receipt.deliveredAtIso } };
}
genericTextReportStep.maxRetries = 0;

/** A committed receipt is reconciliation evidence, never new publication authority. */
export async function genericTextCommittedReceiptStep(jobId: string): Promise<{ deliveredAtIso: string } | null> {
  "use step";
  return readNaiveTextDeliveryReceipt(await makeServiceContext(jobId));
}
genericTextCommittedReceiptStep.maxRetries = 0;

/** Fence the existing notification attempt; an ambiguous dispatch is never repeated. */
export async function genericTextNotifyStep(jobId: string): Promise<boolean> {
  "use step";
  const ctx = await makeServiceContext(jobId);
  const claim = await claimNaiveTextDeliveryNotification(ctx);
  if (claim.status === "pending") return false;
  if (claim.status === "completed") return true;
  await notifyCustomerStep(jobId);
  await completeNaiveTextDeliveryNotification(ctx, claim.token);
  return true;
}
genericTextNotifyStep.maxRetries = 0;
