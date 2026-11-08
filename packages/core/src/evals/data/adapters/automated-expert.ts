import type { AcquisitionRequest, EvaluationDataPorts } from '../acquisition';
import { reviewDigest } from '../binding';
import { reviewExpertContribution, type ExpertContribution, type ExpertContributionReview } from '../expert';
import { inspectDataSafety } from '../quality';

/** Authorized pilot limits, not a payment instruction. All amounts are micro-USD. */
export const AUTOMATED_EXPERT_PILOT_LIMITS = Object.freeze({ jobMicroUsd: 25_000_000, dailyMicroUsd: 50_000_000 });
export interface ExpertLoopScope { jobId: string; taskId: string; operationId: string; requestHash: string }
export interface ExpertContact { id: string; qualified: boolean; optedIn: boolean; honorariumMicroUsd: number }
export interface ExpertInvitation {
 requestId: string; contactId: string; questions: string[]; requiredUses: string[];
 honorariumMicroUsd: number; sharesCustomerScope: boolean;
}
export interface ExpertLoopRecord {
 scope: ExpertLoopScope; revision: number; state: 'selecting' | 'selected' | 'dispatching' | 'sent';
 invitation?: ExpertInvitation; deliveryId?: string;
}
export interface ExpertLoopStore {
 get(operationId: string): Promise<ExpertLoopRecord | null>;
 insertIfAbsent(record: ExpertLoopRecord): Promise<ExpertLoopRecord>;
 compareAndSet(operationId: string, revision: number, next: ExpertLoopRecord): Promise<ExpertLoopRecord | null>;
}
export type ExpertDeliveryReceipt = { status: 'sent'; deliveryId: string } | { status: 'ambiguous' | 'rejected' };
/** Trusted owner endpoints: authenticate scope and keep recipient identity/contact details private.
 * ensureRequest/discover/reserve must durably deduplicate their operation key and reject changed
 * payloads. invite must persist dispatch intent before transport and never retry an ambiguous send.
 * invite must also revalidate current standing policy, recipient and customer-sharing consent at
 * its own dispatch boundary, not trust an earlier caller check. Never release ambiguous reservations.
 * recoverDelivery is read-only; null means unknown, never permission to resend. Reservation covers
 * both job and company-day caps atomically and includes promised honoraria until resolved.
 */
export interface AutomatedExpertOwnerPorts {
 store: ExpertLoopStore;
 authorize(scope: ExpertLoopScope): Promise<{
  allowed: boolean; policyId: string; dayScope: string; customerSharingConsent: boolean;
  approvedColdContactIds: string[]; knownSecrets: readonly string[];
 }>;
 ensureRequest(scope: ExpertLoopScope): Promise<void>;
 discover(scope: ExpertLoopScope, query: { topic: string; limit: number }): Promise<ExpertContact[]>;
 reserve(scope: ExpertLoopScope, input: { key: string; policyId: string; dayScope: string; contactId: string; amountMicroUsd: number; jobCapMicroUsd: number; dailyCapMicroUsd: number }): Promise<boolean>;
 invite(scope: ExpertLoopScope, invitation: ExpertInvitation, key: string): Promise<ExpertDeliveryReceipt>;
 recoverDelivery(scope: ExpertLoopScope, key: string): Promise<ExpertDeliveryReceipt | null>;
 /** Reviews must be minted by an authenticated independent reviewer, never contribution content. */
 contributions(scope: ExpertLoopScope, deliveryId: string): Promise<Array<{ contribution: ExpertContribution; review: ExpertContributionReview }>>;
}
const pending = { status: 'pending' as const };
const genericQuestions = [
 'Provide representative cases and independently verifiable answers in the requested subject area, with limitations and source permissions.',
 'Participation is voluntary. Supply explicit consent for evaluation use, qualification evidence, permitted uses and provenance. Do not provide personal data, credentials, customer transcripts or confidential material.',
];
/** One bounded resumable step. Returns candidates only; acquireEvaluationData's independent
 * reviewCandidates and quality assessment remain mandatory for factual dataset admission.
 * No customer text reaches discovery; topic must be an owner-selected generic subject label.
 */
export function createAutomatedExpertAdapter(ports: AutomatedExpertOwnerPorts, config: { topic: string }): EvaluationDataPorts['expert'] {
 const topic = config.topic;
 if (!topic.trim() || topic.length > 160 || !inspectDataSafety(topic).safe) throw Error('invalid_expert_topic');
 return async raw => {
  const request: AcquisitionRequest = structuredClone(raw);
  const requestHash = reviewDigest({ task: request.task, topic });
  const scope: ExpertLoopScope = { jobId: request.task.jobId, taskId: request.task.taskId, operationId: `expert:${reviewDigest(request.operationKey)}`, requestHash };
  if (!request.operationKey.trim() || request.operationKey.length > 512) throw Error('invalid_expert_operation');
  async function current(value: unknown) {
   const auth = await ports.authorize(structuredClone(scope));
   if (!auth.allowed || !auth.policyId.trim() || !auth.dayScope.trim() || !inspectDataSafety(value, auth.knownSecrets).safe) throw Error('expert_policy_denied');
   return auth;
  }
  await current(request);
  let row = await ports.store.get(scope.operationId);
  if (!row) row = await ports.store.insertIfAbsent({ scope, revision: 0, state: 'selecting' });
  if (reviewDigest(row.scope) !== reviewDigest(scope)) throw Error('expert_request_conflict');
  await current(row);
  await ports.ensureRequest(scope);
  if (row.state === 'selecting') {
   await current({ topic });
   const contacts = await ports.discover(scope, { topic, limit: 10 });
   const auth = await current(contacts);
   if (contacts.length > 10 || new Set(contacts.map(c => c.id)).size !== contacts.length) throw Error('invalid_expert_contacts');
   const selected = contacts.find(c => c.id.trim() && c.qualified && (c.optedIn || auth.approvedColdContactIds.includes(c.id))
    && Number.isSafeInteger(c.honorariumMicroUsd) && c.honorariumMicroUsd >= 0 && c.honorariumMicroUsd <= AUTOMATED_EXPERT_PILOT_LIMITS.jobMicroUsd);
   if (!selected) return pending;
   const invitation: ExpertInvitation = {
    requestId: scope.operationId, contactId: selected.id,
    questions: auth.customerSharingConsent ? [`Subject: ${topic}`, ...genericQuestions, request.task.description, ...request.task.requirements.map(r => r.description)] : [`Subject: ${topic}`, ...genericQuestions],
    requiredUses: [...(request.task.requiredUses ?? ['evaluation'])], honorariumMicroUsd: selected.honorariumMicroUsd, sharesCustomerScope: auth.customerSharingConsent,
   };
   await current(invitation);
   await ports.store.compareAndSet(scope.operationId, row.revision, { ...row, revision: row.revision + 1, state: 'selected', invitation });
   return pending;
  }
  const invitation = row.invitation;
  if (!invitation || invitation.requestId !== scope.operationId) throw Error('invalid_expert_intent');
  const key = `expert-invite:${reviewDigest({ scope, invitation })}`;
  let auth = await current(invitation);
  if (invitation.sharesCustomerScope && !auth.customerSharingConsent) throw Error('expert_consent_revoked');
  if (row.state === 'selected') {
   // Revalidate recipient standing immediately before promising compensation or sending.
   const contacts = await ports.discover(scope, { topic, limit: 10 });
   auth = await current(contacts);
   const contact = contacts.find(c => c.id === invitation.contactId);
   if (!contact?.qualified || (!contact.optedIn && !auth.approvedColdContactIds.includes(contact.id)) || contact.honorariumMicroUsd !== invitation.honorariumMicroUsd) throw Error('expert_contact_revoked');
   if (!await ports.reserve(scope, { key, policyId: auth.policyId, dayScope: auth.dayScope, contactId: contact.id, amountMicroUsd: invitation.honorariumMicroUsd, jobCapMicroUsd: AUTOMATED_EXPERT_PILOT_LIMITS.jobMicroUsd, dailyCapMicroUsd: AUTOMATED_EXPERT_PILOT_LIMITS.dailyMicroUsd })) return pending;
   auth = await current(invitation);
   if (invitation.sharesCustomerScope && !auth.customerSharingConsent) throw Error('expert_consent_revoked');
   const claimed = await ports.store.compareAndSet(scope.operationId, row.revision, { ...row, revision: row.revision + 1, state: 'dispatching' });
   if (!claimed) return pending;
   // A thrown/ambiguous response leaves dispatching durable. Subsequent calls reconcile only.
   await current(invitation);
   const finalAuth = await current(invitation);
   if ((!contact.optedIn && !finalAuth.approvedColdContactIds.includes(contact.id)) || (invitation.sharesCustomerScope && !finalAuth.customerSharingConsent)) throw Error('expert_policy_revoked');
   const receipt = await ports.invite(scope, invitation, key);
   if (receipt.status === 'sent' && receipt.deliveryId.trim()) {
    await current(receipt);
    await ports.store.compareAndSet(scope.operationId, claimed.revision, { ...claimed, revision: claimed.revision + 1, state: 'sent', deliveryId: receipt.deliveryId });
   }
   return pending;
  }
  if (row.state === 'dispatching') {
   await current(invitation);
   const receipt = await ports.recoverDelivery(scope, key);
   if (receipt?.status === 'sent' && receipt.deliveryId.trim()) {
    await current(receipt);
    await ports.store.compareAndSet(scope.operationId, row.revision, { ...row, revision: row.revision + 1, state: 'sent', deliveryId: receipt.deliveryId });
   }
   return pending;
  }
  if (!row.deliveryId?.trim()) throw Error('invalid_expert_delivery');
  await current(row);
  const submissions = await ports.contributions(scope, row.deliveryId);
  auth = await current(submissions);
  if (submissions.length > 10) throw Error('expert_response_limit');
  const accepted = submissions.filter(s => s.contribution.contributorId === invitation.contactId).map(s => ({
   contribution: s.contribution, result: reviewExpertContribution(request.task, s.contribution, s.review, auth.knownSecrets),
  })).filter(s => s.result.accepted);
  if (!accepted.length) return pending;
  const data = { sources: accepted.flatMap(s => s.contribution.sources), cases: accepted.flatMap(s => s.result.cases) };
  if (new Set(data.sources.map(s => s.id)).size !== data.sources.length || new Set(data.cases.map(c => c.id)).size !== data.cases.length) throw Error('expert_response_conflict');
  await current(data);
  return { status: 'complete', data };
 };
}
