import { createHook, FatalError, getWorkflowMetadata } from "workflow";
import { jobHookToken, type JobEvent, type Package, type QualifyResult } from "@ae/core/contracts/index";
import type { Remediation } from "@ae/core/contracts/index";
import type { RunResult } from "@ae/core/contracts/services";
import { connectionFailureMessage, decideAfterQualify, decidePayment, decideResumePlan, isQuoteAcceptance, MAX_CLARIFICATION_ROUNDS,
  MAX_CONNECTION_CHECK_ROUNDS, needsConnectionCheck, selectFindingsForFix, type ResumePhase } from "./decisions";
import {
  cancelStep, commercialMessageStep, declineStep, deliverStep, failStep, neonDeliverySafetyStep, pauseBudgetStep,
  progressStep, setStateStep,
} from "./steps/lifecycle";
import { connectionCheckStep, createQuoteStep, qualifyStep } from "./steps/quote";
import {
  auditTraceStep, createBranchStep, designSuiteStep, investigateStep, persistReportStep, proposeFixStep, renderReportStep, runSuiteStep,
} from "./steps/evaluate";
import { richEvaluationStep } from "./steps/rich-evaluation";
import { refreshRichInventoryStep } from "./steps/rich-inventory-refresh";
import { richModeStep } from "./steps/rich-mode";
import { notifyCustomerStep } from "./steps/notify";
import { flagSettlementFailureStep, settlePaymentStep } from "./steps/billing";
import { discardPartialEvaluationStep, loadResumeSnapshotStep } from "./steps/resume";

type PaymentEvent = Extract<JobEvent, { type: "payment_confirmed" }>;
/** on_hold: paused_budget / payment_review / inconsistent state; the run exits without changing anything (operator decides). */
type Outcome = { jobId: string; status: "delivered" | "cancelled" | "failed" | "paused_budget" | "declined" | "already_finished" | "on_hold" };
type Stopped = { stopped: Outcome["status"] };

/**
 * One workflow per job. States: draft -> needs_clarification* -> quoted -> awaiting_payment -> planning
 * -> running -> investigating -> delivered, with paused_budget / failed / cancelled as exits.
 * All outside input arrives on the single start hook (job:<id>); every I/O is in a "use step" function.
 * Resumable: the starting phase comes from persisted state (decideResumePlan), so restartJobWorkflow can start a
 * fresh run for a job whose previous run died and it skips completed phases.
 */
export async function jobWorkflow(jobId: string): Promise<Outcome> {
  "use workflow";

  using hook = createHook<JobEvent>({ token: jobHookToken(jobId) });
  const events = hook[Symbol.asyncIterator]();
  const stashedPayments: PaymentEvent[] = [];
  const seenPaymentIds: string[] = [];

  async function nextEvent(): Promise<JobEvent> {
    const r = await events.next();
    if (r.done) throw new FatalError("Job event stream closed unexpectedly");
    return r.value;
  }

  /** Waits for the first event `pick` accepts. Cancel ends the wait; early payments are kept for the payment phase. */
  async function waitFor<T>(pick: (e: JobEvent) => T | undefined): Promise<T | { cancelled: string }> {
    for (;;) {
      const e = await nextEvent();
      if (e.type === "cancel") return { cancelled: e.reason };
      if (e.type === "payment_confirmed") stashedPayments.push(e);
      const picked = pick(e);
      if (picked !== undefined) return picked;
    }
  }
  const wasCancelled = <T>(r: T | { cancelled: string }): r is { cancelled: string } =>
    typeof r === "object" && r !== null && "cancelled" in r;

  async function run(): Promise<Outcome> {
    // Where to begin is derived from persisted state, so a run started after a dead one resumes instead of
    // re-qualifying and waiting for events (quote acceptance, payment) that already happened.
    const snap = await loadResumeSnapshotStep(jobId);
    const plan = decideResumePlan(snap);
    if (plan.phase === "finished") return { jobId, status: "already_finished" };
    if (plan.phase === "hold") return { jobId, status: "on_hold" };
    if (snap.receivedRecorded) {
      await progressStep(jobId, "workflow_restarted", `Internal note: workflow restarted, resuming at ${plan.phase}.`);
    } else {
      await progressStep(jobId, "received", "Request received.");
    }

    let pkg: Package = snap.package;
    let quoteVersion = 0;
    let stage: ResumePhase = plan.phase;

    // 1-2. Scope (qualify / clarify / connection check) and quote.
    if (plan.phase === "qualify" || plan.phase === "await_clarification") {
      const scoped = await scope(plan, plan.phase === "await_clarification");
      if ("stopped" in scoped) return { jobId, status: scoped.stopped };
      ({ quoteVersion, package: pkg } = scoped);
      stage = "await_quote_acceptance";
    } else if (plan.phase === "await_quote_acceptance" || plan.phase === "await_payment" || plan.phase === "execute") {
      quoteVersion = plan.quoteVersion;
    }

    // Wait for acceptance of the latest quote version.
    if (stage === "await_quote_acceptance") {
      const accepted = await waitFor((e) => (isQuoteAcceptance(e, quoteVersion) ? true : undefined));
      if (wasCancelled(accepted)) { await cancelStep(jobId, accepted.cancelled); return { jobId, status: "cancelled" }; }
      if (!(await setStateStep(jobId, "awaiting_payment", { milestone: "awaiting_payment", message: "Quote accepted. Waiting for payment." }))) {
        return { jobId, status: "cancelled" };
      }
      stage = "await_payment";
    }

    // 3. Payment: only a payment for the latest quote version unlocks the job.
    if (stage === "await_payment") {
      for (;;) {
        const candidate = stashedPayments.shift();
        const ev: JobEvent = candidate ?? await nextEvent();
        if (ev.type === "cancel") { await cancelStep(jobId, ev.reason); return { jobId, status: "cancelled" }; }
        if (ev.type !== "payment_confirmed") continue;
        const decision = decidePayment(ev, quoteVersion, seenPaymentIds);
        seenPaymentIds.push(ev.paymentId);
        if (decision.action === "accept") break;
        await progressStep(jobId, "payment_ignored",
          decision.reason === "duplicate" ? "Duplicate payment notification ignored." : `Payment for quote v${ev.quoteVersion} ignored; the current quote is v${quoteVersion}.`);
      }
      await progressStep(jobId, "payment_confirmed", "Payment confirmed.");
      stage = "execute";
    } else if (plan.phase === "execute" && plan.announcePayment) {
      // Restart found a valid payment the dead run never acted on (it is not re-sent as an event).
      await progressStep(jobId, "payment_confirmed", "Payment confirmed.");
    }

    // 4. Execute by package. A restart first drops findings/fixes a dead run stored without finishing its report.
    if (stage === "execute") {
      const richMode = await richModeStep();
      if (!richMode && plan.phase === "execute" && plan.discardPartialResults) await discardPartialEvaluationStep(jobId);
      let stopped: Stopped | undefined;
      if (richMode && pkg !== "trace_audit") {
        const status = await richEvaluationStep(jobId, getWorkflowMetadata().workflowRunId);
        if (status !== "complete") stopped = { stopped: status === "paused_budget" ? "paused_budget" : "on_hold" };
      } else {
        stopped = pkg === "trace_audit" ? await runTraceAudit() : await runEndpointEval(pkg);
      }
      if (stopped) return { jobId, status: stopped.stopped };
    }

    // 5. Deadlines (credentials +24h, branch +48h) are stamped here and enforced independently by Cron.
    const delivered = await deliverStep(jobId);
    await neonDeliverySafetyStep(jobId, delivered.deliveredAtIso); // non-fatal: never fails delivery
    // Per-finding pricing: capture $3 per confirmed finding (capped) or release the hold. Never fails delivery.
    try { await settlePaymentStep(jobId); } catch (err) {
      await flagSettlementFailureStep(jobId, err instanceof Error ? err.message : String(err));
    }
    await notifyCustomerStep(jobId);
    if (await richModeStep()) await refreshRichInventoryStep(jobId, getWorkflowMetadata().workflowRunId);
    return { jobId, status: "delivered" };
  }

  /**
   * Qualify, clarifying up to MAX_CLARIFICATION_ROUNDS times. Endpoint packages must also pass a connection
   * check BEFORE a quote exists; a failed check asks the customer to fix it and re-qualifies. `waitFirst` resumes
   * a run that was already waiting for an answer (state needs_clarification).
   */
  async function scope(start: { clarifications: string[]; clarifyRounds: number; checkRounds: number }, waitFirst: boolean):
    Promise<{ quoteVersion: number; package: Package } | Stopped> {
    const clarifications = [...start.clarifications];
    let { clarifyRounds, checkRounds } = start;
    let waiting = waitFirst;
    for (;;) {
      if (waiting) {
        const answer = await waitFor((e) => (e.type === "clarification_answer" ? e.answer : undefined));
        if (wasCancelled(answer)) { await cancelStep(jobId, answer.cancelled); return { stopped: "cancelled" }; }
        clarifications.push(answer);
      }
      const q = await qualifyStep(jobId, clarifications);
      if (q.status === "budget_exceeded") { await pauseBudgetStep(jobId, q.message); return { stopped: "paused_budget" }; }
      const next = decideAfterQualify(q.data.decision, clarifyRounds);
      if (next === "quote") {
        if (!needsConnectionCheck(q.data.package)) return quoteFor(q.data);
        const check = await connectionCheckStep(jobId);
        if (check.ok) return quoteFor(q.data);
        if (++checkRounds > MAX_CONNECTION_CHECK_ROUNDS) {
          await declineStep(jobId, "We still could not connect to your endpoint after several attempts. Please verify it is reachable and start a new request.");
          return { stopped: "declined" };
        }
        await commercialMessageStep(jobId, connectionFailureMessage(check.failures));
      } else if (next === "decline") {
        await declineStep(jobId, q.data.declineReason ?? "We are not able to take on this request.");
        return { stopped: "declined" };
      } else if (next === "give_up") {
        await declineStep(jobId, `We could not scope this request after ${MAX_CLARIFICATION_ROUNDS} rounds of questions. Please start a new request with more detail.`);
        return { stopped: "declined" };
      } else {
        clarifyRounds++;
        await commercialMessageStep(jobId, q.data.questions.map((x, i) => `${i + 1}. ${x}`).join("\n") || "Could you share more detail about what you need?");
      }
      if (!(await setStateStep(jobId, "needs_clarification"))) return { stopped: "cancelled" };
      waiting = true;
    }
  }

  /** Quote (fixed price table). createQuoteStep reuses an identical unaccepted latest quote on retry. */
  async function quoteFor(qualified: QualifyResult): Promise<{ quoteVersion: number; package: Package }> {
    const quote = await createQuoteStep(jobId, qualified);
    return { quoteVersion: quote.version, package: qualified.package };
  }

  async function runTraceAudit(): Promise<Stopped | undefined> {
    if (!(await setStateStep(jobId, "planning", { milestone: "planning", message: "Preparing the trace audit." }))) return { stopped: "cancelled" };
    if (!(await setStateStep(jobId, "running", { milestone: "auditing", message: "Auditing your trace." }))) return { stopped: "cancelled" };
    const audit = await auditTraceStep(jobId);
    if (audit.status === "budget_exceeded") { await pauseBudgetStep(jobId, audit.message); return { stopped: "paused_budget" }; }
    return finishReport(audit.data);
  }

  async function runEndpointEval(pkg: QualifyResult["package"]): Promise<Stopped | undefined> {
    if (!(await setStateStep(jobId, "planning", { milestone: "planning", message: "Designing your test suite." }))) return { stopped: "cancelled" };
    const branch = await createBranchStep(jobId);
    const designed = await designSuiteStep(jobId);
    if (designed.status === "budget_exceeded") { await pauseBudgetStep(jobId, designed.message); return { stopped: "paused_budget" }; }
    const suite = designed.data;

    if (!(await setStateStep(jobId, "running", { milestone: "running", message: "Running the suite against your system." }))) return { stopped: "cancelled" };
    const targets = pkg === "version_comparison"
      ? [{ slot: "endpointA" as const, label: "A" }, { slot: "endpointB" as const, label: "B" }]
      : [{ slot: "endpoint" as const, label: "default" }];
    const runs: RunResult[] = [];
    for (const t of targets) {
      const r = await runSuiteStep(jobId, suite, t.slot, t.label, branch.branchId);
      if (r.status === "budget_exceeded") { await pauseBudgetStep(jobId, r.message); return { stopped: "paused_budget" }; }
      runs.push(r.data);
    }

    if (!(await setStateStep(jobId, "investigating", { milestone: "investigating", message: "Investigating failures and reproducing findings." }))) return { stopped: "cancelled" };
    const inv = await investigateStep(jobId, suite, runs);
    if (inv.status === "budget_exceeded") { await pauseBudgetStep(jobId, inv.message); return { stopped: "paused_budget" }; }
    return finishReport(inv.data, suite);
  }

  async function finishReport(findings: Parameters<typeof renderReportStep>[1], suite?: Parameters<typeof renderReportStep>[2]): Promise<Stopped | undefined> {
    // "Fix, not just find": propose + verify a fix per confirmed finding (max 5). Budget shortfall skips the rest.
    const remediations: Remediation[] = [];
    for (const f of selectFindingsForFix(findings)) {
      const fix = await proposeFixStep(jobId, f, suite);
      if (fix.status === "budget_exceeded") {
        await progressStep(jobId, "fixes_skipped", "Skipped remaining fix verification: per-job budget is limited. Findings are still reported.");
        break;
      }
      if (fix.data) remediations.push(fix.data);
    }
    const rendered = await renderReportStep(jobId, findings, suite, remediations);
    if (rendered.status === "budget_exceeded") { await pauseBudgetStep(jobId, rendered.message); return { stopped: "paused_budget" }; }
    await persistReportStep(jobId, rendered.data);
    return undefined;
  }

  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failStep(jobId, message);
    return { jobId, status: "failed" };
  }
}
