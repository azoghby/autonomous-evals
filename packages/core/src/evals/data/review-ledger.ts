import { casePayload, reviewDigest } from './binding';
import type { DataBatch } from './acquisition';
import type { DataTaskSpec } from './types';
import type { DataOperationLedger } from './operation-ledger';
import { dataReviewRequestDigest, type AuthenticatedDataReview, type DataOrchestrationPorts } from './orchestration';
import { inspectDataSafety } from './quality';

/** Server intake adapter: identity comes exclusively from authenticated human session/authorization. */
export function createAuthenticatedDataReviewLedger(config: {
  operations: DataOperationLedger;
  /** Resolve session and authorize this task/job server-side. Return null for models or unauthorized sessions. */
  authenticateHuman(task: DataTaskSpec): Promise<{ principalId: string } | null>;
  knownSecrets?: readonly string[];
}): {
  submit(input: { receiptId: string; task: DataTaskSpec; candidates: DataBatch; reviewed: DataBatch; decision: 'approved' | 'rejected' }): Promise<void>;
  readReview: DataOrchestrationPorts['readReview'];
} {
  const screen = (value: unknown) => {
    if (!inspectDataSafety(value, config.knownSecrets).safe) throw new Error('Unsafe independent review');
  };
  const keyFor = (digest: string) => `authenticated-data-review:${digest}`;
  return {
    async submit(input) {
      screen(input);
      const principal = await config.authenticateHuman(structuredClone(input.task));
      if (!principal || !/^[A-Za-z0-9_-]{1,96}$/.test(input.receiptId) || !principal.principalId.trim()
        || principal.principalId === input.task.targetId
        || input.candidates.cases.some(c => c.generatorId === principal.principalId)
        || input.candidates.sources.some(s => s.provenance.producerId === principal.principalId)) throw new Error('Independent human authorization required');
      const reviewed = structuredClone(input.reviewed);
      if (new Set(reviewed.cases.map(c => c.id)).size !== reviewed.cases.length
        || new Set(reviewed.sources.map(s => s.id)).size !== reviewed.sources.length
        || reviewed.cases.length !== input.candidates.cases.length
        || reviewed.cases.some(c => !input.candidates.cases.some(original => original.id === c.id && reviewDigest(casePayload(original)) === reviewDigest(casePayload(c))))
        || reviewed.sources.some(s => {
          const original = input.candidates.sources.find(c => c.id === s.id);
          return original && reviewDigest({ ...s, review: original.review, license: original.license }) !== reviewDigest(original);
        })
        || reviewed.sources.some(s => s.review.reviewerId !== principal.principalId)
        || reviewed.cases.some(c => c.verification && c.verification.verifierId !== principal.principalId)) throw new Error('Independent review snapshot mismatch');
      const requestDigest = dataReviewRequestDigest(input.task, input.candidates);
      const review: AuthenticatedDataReview = { receiptId: input.receiptId, requestDigest, principalId: principal.principalId,
        authority: 'authenticated_human', decision: input.decision, data: reviewed };
      screen(review);
      // Both bindings are immutable. A crash between writes is replayable with the identical receipt.
      const receiptKey = `data-review-receipt:${input.receiptId}`;
      const digest = reviewDigest(review);
      await config.operations.claim(receiptKey, digest);
      await config.operations.complete(receiptKey, digest, review);
      const key = keyFor(requestDigest);
      await config.operations.claim(key, digest);
      await config.operations.complete(key, digest, review);
    },
    async readReview(request) {
      screen(request);
      if (request.digest !== dataReviewRequestDigest(request.task, request.data)) throw new Error('Independent review request mismatch');
      const record = await config.operations.get(keyFor(request.digest));
      if (!record || record.state === 'pending') return { status: 'pending' };
      screen(record);
      const review = record.result as AuthenticatedDataReview;
      if (record.digest !== reviewDigest(review) || review.requestDigest !== request.digest) throw new Error('Independent review ledger binding mismatch');
      return { status: 'decided', review: structuredClone(review) };
    },
  };
}
