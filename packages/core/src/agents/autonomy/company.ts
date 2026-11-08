import { qualifyRequest, buildQuote, type IntakeSummary, type FixedQuote } from '../commercial';
import { writeReportSummary } from '../operator';
import type { AgentTaskRunner } from '../session-service';
import type { Finding, JobRef } from '../../evals/types';
import type { DataOperationLedger } from '../../evals/data/operation-ledger';
import { reviewDigest } from '../../evals/data/binding';
import { renderReport } from '../../reporting/render';

export class CompanyEvaluationPendingError extends Error {}

export interface CompanyAuthority {
  schema: 'autonomous-company-v1'; version: string; enabled: boolean;
  maxClarificationRounds: number;
}
export interface CompanyRequest { tenantId: string; job: JobRef; intake: IntakeSummary; round: number }
export interface CompanyEvaluation {
  findings: Finding[]; limitations: string[]; reportArtifactId: string;
  /** Persisted evidence, independently reviewed suite and measured/unknown cost references. */
  evidenceDigest: string; suiteDigest: string; knownCostMicroUsd: number; unknownCosts: string[];
}
export interface CompanyPorts {
  now(): Date; policy: Readonly<CompanyAuthority>; operations: DataOperationLedger; runner: AgentTaskRunner;
  /** Current authenticated scope and configuration; rechecked before every effect, including replay. */
  authorize(request: CompanyRequest): Promise<boolean>;
  /** Authoritative payment store only. A customer/model assertion is never a receipt. */
  payment(quote: FixedQuote): Promise<'paid' | 'waiting' | 'invalid'>;
  data(key: string): Promise<{ status: 'ready' | 'wait_external' | 'not_assessed'; digest: string; reasons: string[] }>;
  /** Existing owned evaluation pipeline: design, independent review, freeze, execute, investigate.
   * Must retain target authorization, SQL reservations and provider receipt recovery. */
  evaluate(key: string, dataDigest: string): Promise<CompanyEvaluation>;
  /** Query retained evaluator result after a lost acknowledgement; NEVER redispatch. */
  recoverEvaluation(key: string): Promise<CompanyEvaluation | null>;
  /** Bounded code-rendered communication outbox, not a network send. */
  enqueue(key: string, message: { kind: 'clarification'; questions: string[] } | {kind: 'quote'; quote: FixedQuote}
    | { kind: 'report_ready'; artifactId: string } | {kind: 'monitoring_offer'}): Promise<void>;
}
export type CompanyProgress = { state: 'manual' | 'clarification' | 'payment_wait' | 'external_data_wait' | 'not_assessed' | 'declined' | 'pending' | 'paused_budget' | 'exception' | 'delivered'; reason: string; policyVersion: string; founderInterventions: 0; costStatus: 'known' | 'unknown'; report?: CompanyEvaluation };

/** One bounded tick. Host scheduler re-enters the same immutable request; no routine founder gate.
 * Pure decisions replay freely; paid ambiguous effects recover by receipt only. Legacy mode is untouched. */
export async function advanceAutonomousCompany(input: CompanyRequest, ports: CompanyPorts): Promise<CompanyProgress> {
  const request = structuredClone(input), policy = structuredClone(ports.policy);
  const progress = (state: CompanyProgress['state'], reason: string, costStatus: 'known'|'unknown' = 'known', report?: CompanyEvaluation): CompanyProgress =>
    ({state, reason, policyVersion: policy.version, founderInterventions: 0, costStatus, ...(report ? {report} : {})});
  if (!policy.enabled) return progress('manual', 'legacy_manual_mode');
  if (policy.schema !== 'autonomous-company-v1' || !policy.version || !Number.isSafeInteger(policy.maxClarificationRounds)
    || policy.maxClarificationRounds < 0 || policy.maxClarificationRounds > 5 || !Number.isSafeInteger(request.round) || request.round < 0
    || request.tenantId !== request.job.customerId || request.intake.requestedPackage !== request.job.package) throw new Error('company_authority_refused');
  const authorized = async () => { if (!await ports.authorize(structuredClone(request))) throw new Error('company_scope_refused'); };
  await authorized();
  const identity = reviewDigest({request, policy});
  const prefix = `autonomous-company:${request.tenantId}:${request.job.jobId}:${request.round}`;
  // Immutable identity prevents an injected new policy/customer body from reusing prior authority.
  await ports.operations.claim(`${prefix}:identity`, identity);
  await ports.operations.complete(`${prefix}:identity`, identity, {policyVersion: policy.version});
  const audit = async (result: CompanyProgress) => {
    const key = `${prefix}:decision:${reviewDigest(result)}`;
    const receipt = {authority:'automated_company_policy_v1', requestDigest:identity, ...result};
    const digest = reviewDigest(receipt);
    await ports.operations.claim(key, digest); await ports.operations.complete(key, digest, receipt);
    return result;
  };
  const qualification = await qualifyRequest({job:request.job, intake:request.intake, round:request.round}, ports.runner);
  if (qualification.status !== 'completed') return audit(progress(qualification.status === 'pending' ? 'pending' : ['budget_paused','budget_exhausted'].includes(qualification.status) ? 'paused_budget' : 'exception', `qualification_${qualification.status}`, qualification.status === 'pending' || qualification.status === 'needs_operator' && !qualification.cost ? 'unknown' : 'known'));
  const q = qualification.value;
  if (q.decision === 'decline') return audit(progress('declined','out_of_scope'));
  await authorized();
  if (q.decision === 'clarify') {
    if (request.round >= policy.maxClarificationRounds || !q.questions.length) return audit(progress('declined', 'clarification_limit_or_invalid_question'));
    await ports.enqueue(`${prefix}:clarification`, {kind:'clarification', questions:q.questions});
    return audit(progress('clarification','waiting_for_customer_answer'));
  }
  const quote = buildQuote(request.job, q.package, request.job.quoteVersion ?? 1, q.scopeSummary);
  await ports.enqueue(`${prefix}:quote`, {kind:'quote',quote});
  const payment = await ports.payment(quote);
  if (payment !== 'paid') return audit(progress(payment === 'waiting' ? 'payment_wait' : 'exception',payment === 'waiting' ? 'waiting_for_authoritative_payment' : 'invalid_payment_receipt'));
  await authorized();
  const data = await ports.data(`${prefix}:data`);
  if (data.status !== 'ready') return audit(progress(data.status === 'wait_external' ? 'external_data_wait' : 'not_assessed', 'insufficient_independent_evidence'));
  if (!/^[a-f0-9]{64}$/.test(data.digest)) throw new Error('company_data_binding_refused');
  const evalKey = `${prefix}:evaluation`, evalDigest = reviewDigest({identity,dataDigest:data.digest});
  const claimed = await ports.operations.claim(evalKey, evalDigest);
  let report: CompanyEvaluation;
  if (claimed.record.state === 'complete') report = claimed.record.result as CompanyEvaluation;
  else {
    await authorized();
    try {
      const recovered = claimed.claimed ? await ports.evaluate(evalKey,data.digest) : await ports.recoverEvaluation(evalKey);
      if (!recovered) return audit(progress('exception','evaluation_receipt_unavailable','unknown'));
      report = recovered;
      if (!/^[a-f0-9]{64}$/.test(report.evidenceDigest) || !/^[a-f0-9]{64}$/.test(report.suiteDigest) || !report.reportArtifactId
        || !Number.isSafeInteger(report.knownCostMicroUsd) || report.knownCostMicroUsd < 0) throw new Error('invalid_evaluation_receipt');
      await ports.operations.complete(evalKey,evalDigest,report);
    } catch (error) { return audit(progress(error instanceof CompanyEvaluationPendingError ? 'pending' : 'exception',error instanceof CompanyEvaluationPendingError ? 'evaluation_agent_pending' : 'evaluation_ambiguous_no_redispatch','unknown')); }
  }
  await authorized();
  const summary = await writeReportSummary({job:request.job,findings:report.findings,limitations:report.limitations},ports.runner);
  if (summary.status !== 'completed') return audit(progress(summary.status === 'pending' ? 'pending' : 'exception',`report_${summary.status}`, summary.status === 'pending' || summary.status === 'needs_operator' && !summary.cost ? 'unknown' : 'known'));
  const summaryKey = `${prefix}:summary`, digest = reviewDigest(summary.value);
  await ports.operations.claim(summaryKey,digest); await ports.operations.complete(summaryKey,digest,summary.value);
  await authorized();
  const publishedKey = `${prefix}:published-report`;
  const existingPublication = await ports.operations.get(publishedKey);
  if (!existingPublication) {
    const rendered = renderReport({job:request.job,generatedAt:ports.now().toISOString(),findings:report.findings,
      limitations:report.limitations,operatorSummary:summary.value,costs:null,evaluationStatus:'unresolved',includeHtml:true,
      details:{evidenceDigest:report.evidenceDigest,suiteDigest:report.suiteDigest,knownEvaluationCostMicroUsd:report.knownCostMicroUsd,unknownCosts:report.unknownCosts}});
    const publication = {artifactId:report.reportArtifactId,tenantId:request.tenantId,jobId:request.job.jobId,rendered};
    const publicationDigest = reviewDigest(publication);
    await ports.operations.claim(publishedKey,publicationDigest); await ports.operations.complete(publishedKey,publicationDigest,publication);
  } else if(existingPublication.state!=='complete') return audit(progress('exception','publication_receipt_pending','unknown'));
  await ports.enqueue(`${prefix}:report`, {kind:'report_ready',artifactId:report.reportArtifactId});
  try { await ports.enqueue(`${prefix}:monitoring-offer`, {kind:'monitoring_offer'}); }
  catch { await audit(progress('delivered','optional_monitoring_offer_not_queued_by_current_policy','unknown')); }
  return audit(progress('delivered','report_retained_and_notification_queued',report.unknownCosts.length ? 'unknown' : 'known',report));
}
