import { createHook, FatalError } from "workflow";
import { jobHookToken, type JobEvent, type QualifyResult } from "@ae/core/contracts/index";
import type { RunResult } from "@ae/core/contracts/services";
import { decideAfterQualify, decidePayment, isQuoteAcceptance, MAX_CLARIFICATION_ROUNDS } from "./decisions";
import {
  cancelStep, commercialMessageStep, declineStep, deliverStep, failStep, getStateStep, pauseBudgetStep,
  progressStep, setStateStep,
} from "./steps/lifecycle";
import { createQuoteStep, qualifyStep } from "./steps/quote";
import {
  auditTraceStep, createBranchStep, designSuiteStep, investigateStep, persistReportStep, renderReportStep, runSuiteStep,
} from "./steps/evaluate";
import { notifyCustomerStep } from "./steps/notify";

type PaymentEvent = Extract<JobEvent, { type: "payment_confirmed" }>;
type Outcome = { jobId: string; status: "delivered" | "cancelled" | "failed" | "paused_budget" | "declined" | "already_finished" };
type Stopped = { stopped: Outcome["status"] };

/**
 * One workflow per job. States: draft -> needs_clarification* -> quoted -> awaiting_payment -> planning
 * -> running -> investigating -> delivered, with paused_budget / failed / cancelled as exits.
 * All outside input arrives on the single start hook (job:<id>); every I/O is in a "use step" function.
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
    const initial = await getStateStep(jobId);
    if (initial === "delivered" || initial === "cancelled" || initial === "failed") {
      return { jobId, status: "already_finished" };
    }
    await progressStep(jobId, "received", "Request received.");

    // 1. Qualify, clarifying up to MAX_CLARIFICATION_ROUNDS times.
    const clarifications: string[] = [];
    let qualified: QualifyResult | undefined;
    for (let round = 0; !qualified; round++) {
      const q = await qualifyStep(jobId, clarifications);
      if (q.status === "budget_exceeded") { await pauseBudgetStep(jobId, q.message); return { jobId, status: "paused_budget" }; }
      const next = decideAfterQualify(q.data.decision, round);
      if (next === "quote") { qualified = q.data; break; }
      if (next === "decline") {
        await declineStep(jobId, q.data.declineReason ?? "We are not able to take on this request.");
        return { jobId, status: "declined" };
      }
      if (next === "give_up") {
        await declineStep(jobId, `We could not scope this request after ${MAX_CLARIFICATION_ROUNDS} rounds of questions. Please start a new request with more detail.`);
        return { jobId, status: "declined" };
      }
      await commercialMessageStep(jobId, q.data.questions.map((x, i) => `${i + 1}. ${x}`).join("\n") || "Could you share more detail about what you need?");
      if (!(await setStateStep(jobId, "needs_clarification"))) return { jobId, status: "cancelled" };
      const answer = await waitFor((e) => (e.type === "clarification_answer" ? e.answer : undefined));
      if (wasCancelled(answer)) { await cancelStep(jobId, answer.cancelled); return { jobId, status: "cancelled" }; }
      clarifications.push(answer);
    }

    // 2. Quote (fixed price table), wait for acceptance of the latest version.
    const quote = await createQuoteStep(jobId, qualified);
    const accepted = await waitFor((e) => (isQuoteAcceptance(e, quote.version) ? true : undefined));
    if (wasCancelled(accepted)) { await cancelStep(jobId, accepted.cancelled); return { jobId, status: "cancelled" }; }
    if (!(await setStateStep(jobId, "awaiting_payment", { milestone: "awaiting_payment", message: "Quote accepted. Waiting for payment." }))) {
      return { jobId, status: "cancelled" };
    }

    // 3. Payment: only a payment for the latest quote version unlocks the job.
    for (;;) {
      const candidate = stashedPayments.shift();
      const ev: JobEvent = candidate ?? await nextEvent();
      if (ev.type === "cancel") { await cancelStep(jobId, ev.reason); return { jobId, status: "cancelled" }; }
      if (ev.type !== "payment_confirmed") continue;
      const decision = decidePayment(ev, quote.version, seenPaymentIds);
      seenPaymentIds.push(ev.paymentId);
      if (decision.action === "accept") break;
      await progressStep(jobId, "payment_ignored",
        decision.reason === "duplicate" ? "Duplicate payment notification ignored." : `Payment for quote v${ev.quoteVersion} ignored; the current quote is v${quote.version}.`);
    }
    await progressStep(jobId, "payment_confirmed", "Payment confirmed.");

    // 4. Execute by package.
    const stopped = qualified.package === "trace_audit" ? await runTraceAudit() : await runEndpointEval(qualified.package);
    if (stopped) return { jobId, status: stopped.stopped };

    // 5. Deadlines (credentials +24h, branch +48h) are stamped here and enforced independently by Cron.
    await deliverStep(jobId);
    await notifyCustomerStep(jobId);
    return { jobId, status: "delivered" };
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
      const r = await runSuiteStep(jobId, suite, t.slot, t.label, branch.connectionString);
      if (r.status === "budget_exceeded") { await pauseBudgetStep(jobId, r.message); return { stopped: "paused_budget" }; }
      runs.push(r.data);
    }

    if (!(await setStateStep(jobId, "investigating", { milestone: "investigating", message: "Investigating failures and reproducing findings." }))) return { stopped: "cancelled" };
    const inv = await investigateStep(jobId, suite, runs);
    if (inv.status === "budget_exceeded") { await pauseBudgetStep(jobId, inv.message); return { stopped: "paused_budget" }; }
    return finishReport(inv.data, suite);
  }

  async function finishReport(findings: Parameters<typeof renderReportStep>[1], suite?: Parameters<typeof renderReportStep>[2]): Promise<Stopped | undefined> {
    const rendered = await renderReportStep(jobId, findings, suite);
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
