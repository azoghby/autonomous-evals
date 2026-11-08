import { createHash } from 'node:crypto';
import { acquireEvaluationData, type AcquisitionRequest, type AcquisitionResult, type DataBatch, type EvaluationDataPorts, type EvaluationDataTask } from './acquisition';
import { casePayload, reviewDigest } from './binding';
import { inspectDataSafety } from './quality';
import type { DataTaskSpec } from './types';
import type { DataOperationLedger } from './operation-ledger';
import { frozenDataReference, mapApprovedDataToTextDesign, type DataDesignContext, type DataReferenceProvenance } from './adapters/mapping';
import type { GenerationMeasuredCost } from './adapters/generation';
import type { FrozenTextSuite } from '../text/schema';
import { CostEntrySchema } from '../types';

export interface AuthenticatedDataReview {
  receiptId: string;
  /** Bound by the authenticated intake service to the complete task and candidate snapshot. */
  requestDigest: string;
  principalId: string;
  authority: 'authenticated_human';
  decision: 'approved' | 'rejected';
  data: DataBatch;
}
export type DataFreezePort = (request: { operationKey: string; mapping: Extract<ReturnType<typeof mapApprovedDataToTextDesign>, { status: 'ready' }> }) => Promise<
  { status: 'pending' } | { status: 'complete'; suite: FrozenTextSuite }>;

export interface DataOrchestrationPorts {
  acquisition: Omit<EvaluationDataPorts, 'reviewCandidates' | 'knownSecrets'>;
  operations: DataOperationLedger;
  /** Explicit provider-owned advancement for a durable expert adapter. It must use its own
   * persisted dispatch intent/CAS and read-only reconciliation for ambiguous sends. Never
   * supply a stateless mail sender here. Absent this port, pending effects remain fenced. */
  resumeExpert?: EvaluationDataPorts['expert'];
  /** Explicit reconciliation using the same durable AgentSessionService task identity.
   * Never supply a stateless generator; absent this port pending generation stays fenced. */
  resumeGeneration?: EvaluationDataPorts['generate'];
  /** Explicit reconciliation of durable suite design sessions under the same operation scope. */
  resumeFreeze?: DataFreezePort;
  /** Server-only immutable review ledger. Never pass a generator/model implementation here. */
  readReview(request: { digest: string; task: DataTaskSpec; data: DataBatch }): Promise<
    { status: 'pending' } | { status: 'decided'; review: AuthenticatedDataReview }>;
  /** Existing design/review/freeze service; must honor key and enforce its own suite review gates. */
  freeze: DataFreezePort;
  /** Durable idempotent upsert by taskKey + cost.externalId, never an increment-on-retry sink. */
  deliverCost(entry: GenerationMeasuredCost): Promise<void>;
  knownSecrets?: readonly string[];
}
export type DataOrchestrationResult = {
  status: 'waiting_for_data' | 'waiting_for_review' | 'reconciliation_required' | 'cost_delivery_pending' | 'mapping_blocked' | 'ready';
  task: EvaluationDataTask;
  /** Fixed prose only; no provider errors, corpus, contributor or reviewer identities. */
  progress: { outcome: 'ready' | 'inconclusive'; factualCorrectness: 'assessed' | 'unassessed'; message: string };
  frozen?: { suite: FrozenTextSuite; provenance: DataReferenceProvenance };
};

export function dataReviewRequestDigest(task: DataTaskSpec, data: DataBatch): string {
  return reviewDigest({ version: 'data-orchestration-review-v1', task, data });
}

/** Durable measured-cost outbox callback for createNaiveGenerationAdapter. Capture before delivery. */
export function createDataCostCapture(operations: DataOperationLedger, knownSecrets: readonly string[] = []) {
  return async (entry: GenerationMeasuredCost): Promise<void> => {
    if (!CostEntrySchema.safeParse(entry.cost).success || !entry.taskKey.trim() || !entry.operationKey.trim() || !entry.cost.measured || !entry.cost.externalId || !inspectDataSafety(entry, knownSecrets).safe) throw new Error('Invalid data cost');
    const key = `${entry.operationKey}:cost`;
    const digest = reviewDigest(entry);
    await operations.claim(key, digest);
    await operations.complete(key, digest, structuredClone(entry));
  };
}

/** One bounded step for the host workflow. No scheduler, network client, outreach or spend authority. */
export async function advanceDataOrchestration(
  spec: DataTaskSpec, initial: DataBatch, context: DataDesignContext, ports: DataOrchestrationPorts,
): Promise<DataOrchestrationResult> {
  spec = structuredClone(spec);
  initial = structuredClone(initial);
  context = structuredClone(context);
  const secrets = [...new Set([...(ports.knownSecrets ?? []), ...(context.knownSecrets ?? [])])];
  const screen = (value: unknown) => { if (!inspectDataSafety(value, secrets).safe) throw new Error('Unsafe orchestration data'); };
  screen({ spec, initial, context: { ...context, knownSecrets: undefined } });
  // Imported evidence is candidate input. Only the authenticated ledger may reinstate approvals.
  initial = {
    sources: initial.sources.map(s => ({ ...s, review: { status: 'pending', reviewerId: '', reviewedAt: '', notes: '' } })),
    cases: initial.cases.map(c => { const { verification: _verification, ...candidate } = c; return candidate; }),
  };
  const requestHash = createHash('sha256').update(JSON.stringify({ spec, initial })).digest('hex');
  const prefix = `evaluation-data:${spec.taskId}:${requestHash}`;
  let needsReconciliation = false;
  let waitingReview = false;
  const wrap = (phase: 'discovery' | 'generation' | 'expert', provider: EvaluationDataPorts['discover']) => async (request: AcquisitionRequest): Promise<AcquisitionResult> => {
    screen(request);
    const digest = reviewDigest(request);
    const claim = await ports.operations.claim(request.operationKey, digest);
    screen(claim.record);
    if (claim.record.digest !== digest) throw new Error('Data operation identity conflict');
    if (!claim.claimed) {
      if (claim.record.state === 'complete') return structuredClone(claim.record.result) as AcquisitionResult;
      if (phase === 'expert' && ports.resumeExpert) provider = ports.resumeExpert;
      else if (phase === 'generation' && ports.resumeGeneration) provider = ports.resumeGeneration;
      else {
        needsReconciliation = true;
        return { status: 'pending' };
      }
    }
    // Crash/exception/pending leaves an owned ambiguous operation. Only explicit reconciliation
    // with the underlying durable provider ledger may complete it; time never authorizes retry.
    // Opt-in resume ports advance the provider's durable state machine under the same identity.
    try {
      const result = await provider(structuredClone(request));
      screen(result);
      if (result.status === 'pending') { needsReconciliation = true; return result; }
      if (result.status !== 'complete' && !(phase === 'discovery' && result.status === 'rejected')) throw new Error('Invalid operation result');
      if (phase === 'generation' && result.status === 'complete') {
        const cost = await ports.operations.get(`${request.operationKey}:cost`);
        if (!cost || cost.state !== 'complete') throw new Error('Measured generation cost missing');
        screen(cost);
      }
      await ports.operations.complete(request.operationKey, digest, result);
      return result;
    } catch { needsReconciliation = true; return { status: 'pending' }; }
  };
  const reviewCandidates: NonNullable<EvaluationDataPorts['reviewCandidates']> = async (data, request) => {
    waitingReview = true;
    screen(data);
    const digest = dataReviewRequestDigest(spec, data);
    const key = `${prefix}:review:${digest}`;
    const cached = await ports.operations.get(key);
    if (cached) screen(cached);
    let review: AuthenticatedDataReview;
    if (cached?.state === 'complete') review = cached.result as AuthenticatedDataReview;
    else {
      const result = await ports.readReview({ digest, task: structuredClone(spec), data: structuredClone(data) });
      if (result.status === 'pending') { waitingReview = true; throw new Error('Independent review pending'); }
      review = result.review;
    }
    screen(review);
    if (review.authority !== 'authenticated_human' || review.decision !== 'approved' || review.requestDigest !== digest
      || !/^[A-Za-z0-9_-]{1,96}$/.test(review.receiptId) || !review.principalId.trim() || review.principalId === spec.targetId
      || data.cases.some(c => c.generatorId === review.principalId)
      || data.sources.some(s => s.provenance.producerId === review.principalId)
      || review.data.sources.some(s => s.provenance.producerId === review.principalId)
      || review.data.sources.some(s => s.review.reviewerId !== review.principalId)
      || review.data.cases.some(c => c.verification && c.verification.verifierId !== review.principalId)
      || review.data.cases.length !== data.cases.length
      || review.data.cases.some(c => !data.cases.some(original => original.id === c.id && reviewDigest(casePayload(original)) === reviewDigest(casePayload(c))))) {
      throw new Error('Invalid independent review authority or binding');
    }
    // A receipt cannot authorize a second mutable snapshot, even under a different task key.
    const receiptKey = `data-review-receipt:${review.receiptId}`;
    const receiptDigest = reviewDigest(review);
    await ports.operations.claim(receiptKey, receiptDigest);
    await ports.operations.complete(receiptKey, receiptDigest, review);
    await ports.operations.claim(key, digest);
    await ports.operations.complete(key, digest, review);
    waitingReview = false;
    return structuredClone(review.data);
  };
  let costsPending = false;
  async function deliverCosts() {
    const record = await ports.operations.get(`${prefix}:generation:cost`);
    if (!record) return;
    screen(record);
    if (record.state !== 'complete') { costsPending = true; return; }
    const entry = record.result as GenerationMeasuredCost;
    if (!CostEntrySchema.safeParse(entry.cost).success || entry.operationKey !== `${prefix}:generation` || entry.cost.jobId !== spec.jobId || !entry.cost.measured || !entry.cost.externalId) throw new Error('Cost scope mismatch');
    try { await ports.deliverCost(structuredClone(entry)); } catch { costsPending = true; }
  }
  await deliverCosts();
  const task = await acquireEvaluationData(spec, initial, {
    ...ports.acquisition, knownSecrets: secrets,
    discover: wrap('discovery', ports.acquisition.discover), generate: wrap('generation', ports.acquisition.generate),
    expert: wrap('expert', ports.acquisition.expert), reviewCandidates,
  });
  await deliverCosts();
  const result = (status: DataOrchestrationResult['status'], frozen?: DataOrchestrationResult['frozen']): DataOrchestrationResult => ({
    status, task,
    progress: { outcome: status === 'ready' ? 'ready' : 'inconclusive', factualCorrectness: task.assessment.factualCorrectness,
      message: status === 'ready' ? 'Reviewed evaluation data is bound to the frozen text suite.'
        : status === 'reconciliation_required' ? 'Data work is awaiting durable operation reconciliation.'
        : status === 'cost_delivery_pending' ? 'Measured data work costs are awaiting durable delivery.'
        : status === 'waiting_for_review' ? 'Evaluation data is awaiting independent authenticated review.'
        : 'Evaluation evidence or suite mapping is incomplete.' }, ...(frozen ? { frozen } : {}),
  });
  if (costsPending) return result('cost_delivery_pending');
  if (needsReconciliation) return result('reconciliation_required');
  if (waitingReview) return result('waiting_for_review');
  if (task.state !== 'ready') return result('waiting_for_data');
  const mapping = mapApprovedDataToTextDesign(task, { ...context, knownSecrets: secrets });
  if (mapping.status !== 'ready') return result('mapping_blocked');
  const key = `${prefix}:freeze`;
  const digest = reviewDigest({ context: { ...context, knownSecrets: undefined }, provenance: mapping.provenance });
  const claim = await ports.operations.claim(key, digest);
  screen(claim.record);
  if (claim.record.digest !== digest) throw new Error('Data operation identity conflict');
  let suite: FrozenTextSuite;
  if (claim.record.state === 'complete') suite = claim.record.result as FrozenTextSuite;
  else if (!claim.claimed && !ports.resumeFreeze) return result('reconciliation_required');
  else {
    try {
      const freeze = claim.claimed ? ports.freeze : ports.resumeFreeze!;
      const frozen = await freeze({ operationKey: key, mapping: { ...structuredClone(mapping), designInput: { ...mapping.designInput, knownSecrets: undefined } } });
      if (frozen.status === 'pending') return result('reconciliation_required');
      suite = frozen.suite;
      screen(suite);
      frozenDataReference(task, suite, { ...context, knownSecrets: secrets });
      await ports.operations.complete(key, digest, suite);
    } catch { return result('reconciliation_required'); }
  }
  screen(suite);
  const binding = frozenDataReference(task, suite, { ...context, knownSecrets: secrets });
  return result('ready', { suite: structuredClone(suite), provenance: binding.provenance });
}
