import 'server-only';
import { z } from 'zod';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { requireOperator } from './http';
import { getCurrentCustomer } from './session';
import { listExpertWorkflowReviews, readExpertWorkflowReview, reviewExpertWorkflowContribution,
  reviewExpertWorkflowData, type ExpertWorkflowReviewKind } from './expert-data-production';

export const expertReviewHeaders = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
const response = (data: unknown, status = 200) => Response.json(data, { status, headers: expertReviewHeaders });
const failure = (status: number, error: string) => response({ error }, status);
const id = z.string().min(1).max(96);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(100_000);
const date = z.string().max(64).refine(v => Number.isFinite(Date.parse(v)));
const ids = z.array(id).max(500);
const reviewStatus = z.enum(['pending', 'approved', 'rejected']);
const verification = z.object({
  contextDigest: digest.optional(), status: reviewStatus, method: z.enum(['independent_evidence', 'expert']),
  verifierId: z.string().max(96), independentOfTarget: z.boolean(), independentOfGenerator: z.boolean(),
  evidenceSourceIds: ids, reviewedAnswer: text, reviewedAt: date, rationale: text,
  expertAttestation: z.object({ qualified: z.boolean(), consentToEvaluation: z.boolean(), contributionId: id,
    contributionContextDigest: digest.optional() }).strict().optional(),
}).strict();
const dataBatch = z.object({
  sources: z.array(z.object({ id, url: text, content: text,
    license: z.object({ name: text, url: text, permission: z.enum(['allowed', 'denied', 'unknown', 'mixed']),
      allowedUses: z.array(z.enum(['evaluation', 'generation', 'redistribution'])).max(3) }).strict(),
    provenance: z.object({ origin: z.enum(['public', 'customer', 'expert', 'synthetic', 'evaluation_target']),
      producerId: id, retrievedAt: date, contentHash: text }).strict(),
    review: z.object({ status: reviewStatus, reviewerId: z.string().max(96), reviewedAt: date, notes: text }).strict(),
  }).strict()).max(500),
  cases: z.array(z.object({ id, input: text, requirementIds: ids, synthetic: z.boolean(), generatorId: id.optional(),
    sourceIds: ids, expectedAnswer: text.optional(), verification: verification.optional() }).strict()).max(500),
}).strict();
const contributionSubmission = z.object({ snapshotDigest: digest, attestation: z.literal(true),
  review: z.object({ contributionId: id, reviewedAt: date, qualificationsVerified: z.boolean(), consentVerified: z.boolean(),
    conflictOfInterestCleared: z.boolean(), approvedAnswers: z.array(z.object({ caseId: id, exactAnswer: text,
      rationale: text, evidenceSourceIds: ids }).strict()).max(500) }).strict(),
}).strict();
const corpusSubmission = z.object({ snapshotDigest: digest, attestation: z.literal(true), decision: z.enum(['approved', 'rejected']),
  reviewed: dataBatch }).strict();
const routeParams = z.object({ jobId: z.uuid(), kind: z.enum(['contribution', 'corpus']), digest }).strict();
export type ExpertReviewParams = { jobId: string; kind: string; digest: string };

async function authenticated() {
  const auth = await requireOperator();
  if (auth.res) return { res: response(await auth.res.json(), auth.res.status) };
  return { principalId: auth.viewer.id };
}
async function recheck(principalId: string) {
  const current = await getCurrentCustomer();
  return current?.isOperator && current.id === principalId;
}
function knownError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'expert_review_invalid_cursor') return failure(400, 'Invalid review cursor');
  if (message === 'expert_review_unauthorized') return failure(403, 'Operator authorization changed');
  if (message === 'expert_review_snapshot_mismatch' || message === 'expert_review_conflict' || message === 'data_operation_immutable_conflict') return failure(409, 'Review snapshot changed or conflicts with a retained review');
  if (message === 'expert_review_invalid' || message === 'Independent review snapshot mismatch'
    || message === 'Independent human authorization required') return failure(422, 'Review does not satisfy independent review requirements');
  return failure(404, 'Review unavailable');
}

/** Stream before JSON parsing: Content-Length alone is not a size boundary. */
async function boundedJson(request: Request): Promise<unknown> {
  const max = 450_000;
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('review_content_type');
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > max)) throw new Error('review_body_large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('review_body_invalid');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) { await reader.cancel(); throw new Error('review_body_large'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('review_body_invalid'); }
}

export async function getExpertReviewQueue(request?: Request) {
  const auth = await authenticated();
  if (auth.res) return auth.res;
  try {
    const params = request ? new URL(request.url).searchParams : new URLSearchParams();
    if ([...params.keys()].some(key => key !== 'cursor') || params.getAll('cursor').length > 1) return failure(400, 'Invalid queue parameters');
    const result = await listExpertWorkflowReviews(auth.principalId, params.get('cursor') ?? undefined);
    if (!await recheck(auth.principalId)) return failure(403, 'Operator authorization changed');
    return response(result);
  } catch (error) {
    if (!await recheck(auth.principalId)) return failure(403, 'Operator authorization changed');
    return knownError(error);
  }
}
export async function getExpertReview(params: ExpertReviewParams) {
  const auth = await authenticated();
  if (auth.res) return auth.res;
  const parsed = routeParams.safeParse(params);
  if (!parsed.success) return failure(400, 'Invalid review reference');
  try {
    const { jobId, kind, digest: key } = parsed.data;
    const result = await readExpertWorkflowReview(jobId, kind, key, auth.principalId);
    if (!await recheck(auth.principalId)) return failure(403, 'Operator authorization changed');
    return response(result);
  } catch (error) {
    if (!await recheck(auth.principalId)) return failure(403, 'Operator authorization changed');
    return knownError(error);
  }
}
export async function postExpertReview(request: Request, params: ExpertReviewParams) {
  const auth = await authenticated();
  if (auth.res) return auth.res;
  const parsed = routeParams.safeParse(params);
  if (!parsed.success) return failure(400, 'Invalid review reference');
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return failure(403, 'Invalid request origin');
  let body: unknown;
  try { body = await boundedJson(request); }
  catch (error) { return failure(error instanceof Error && error.message === 'review_body_large' ? 413 : 400, 'Invalid review request body'); }
  if (!await recheck(auth.principalId)) return failure(403, 'Operator authorization changed');
  const { jobId, kind, digest: key } = parsed.data;
  try {
    if (kind === 'contribution') {
      const submission = contributionSubmission.safeParse(body);
      if (!submission.success) return failure(400, 'Invalid contribution review');
      await reviewExpertWorkflowContribution(jobId, key, { ...submission.data.review, reviewerId: auth.principalId }, auth.principalId, submission.data.snapshotDigest);
    } else {
      const submission = corpusSubmission.safeParse(body);
      if (!submission.success) return failure(400, 'Invalid corpus review');
      const { decision, reviewed, snapshotDigest } = submission.data;
      const receiptId = reviewDigest({ principalId: auth.principalId, jobId, digest: key, snapshotDigest, decision, reviewed });
      await reviewExpertWorkflowData(jobId, key, { receiptId, decision, reviewed }, auth.principalId, snapshotDigest);
    }
    if (!await recheck(auth.principalId)) return failure(403, 'Operator authorization changed');
    return response({ status: 'recorded' });
  } catch (error) {
    if (!await recheck(auth.principalId)) return failure(403, 'Operator authorization changed');
    return knownError(error);
  }
}
