import { createHash } from 'node:crypto';
import { reviewDigest } from '../binding';
import { inspectDataSafety } from '../quality';
import type { DataBatch } from '../acquisition';
import type { DataOperationLedger } from '../operation-ledger';
import type { DataTaskSpec, DataUse } from '../types';

export interface AuthorizedSource {
  sourceId: string;
  url: string;
  contentHash: string;
  producerId: string;
  /** Receipt issued by an authenticated retrieval/permission service, never an LLM. */
  evidenceReceiptId: string;
  permissionReceiptId: string;
  allowedUses: DataUse[];
  expiresAt: string;
}
export interface AuthorizedFact {
  sourceId: string;
  question: string;
  answer: string;
  /** Exact excerpt of the authorized source; answer must occur inside it. */
  excerpt: string;
}
/** Construct exclusively from server-controlled configuration. No agent/customer writer. */
export interface AutonomousDataPolicy {
  schemaVersion: 'autonomous-data-policy-v1';
  version: string;
  enabled: boolean;
  tenantId: string;
  checker: { principalId: string; version: string };
  sources: AuthorizedSource[];
  facts: AuthorizedFact[];
  maxSourceCycles: number;
  maxGenerationCycles: number;
  deadline: string;
  expert?: { recipientId: string; consentPolicyId: string; approved: boolean };
}
export interface AutonomousDataRequest {
  tenantId: string;
  task: DataTaskSpec;
  candidates: DataBatch;
  /** Entire frozen evaluation context, including reference constraints and target version. */
  context: unknown;
  cycle: number;
  /** Server clock, never a customer-supplied timestamp. */
  now: string;
}
export interface AutonomousDataDecision {
  authority: 'automated_data_policy_v1';
  policyVersion: string;
  policyDigest: string;
  checker: { principalId: string; version: string };
  requestDigest: string;
  contextDigest: string;
  permissionDigest: string;
  status: 'ready' | 'acquire_sources' | 'generate' | 'wait_external' | 'not_assessed';
  factualCorrectness: 'assessed' | 'unassessed';
  approvedCaseIds: string[];
  approvedFacts: Array<{ caseId: string; answer: string; sourceIds: string[] }>;
  reasons: string[];
  cost: { status: 'known'; microUsd: 0 };
  /** A request proposal only. A separately authorized outbox must enforce recipient consent. */
  expertRequest?: { recipientId: string; consentPolicyId: string; requestDigest: string };
}

const id = (value: string) => /^[A-Za-z0-9_-]{1,96}$/.test(value);
const validTime = (value: string) => Number.isFinite(Date.parse(value));
const https = (value: string) => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
};

/** Deterministic service authority, intentionally incompatible with AuthenticatedDataReview.
 * The existing human ledger and legacy acquireEvaluationData remain unchanged. This output
 * must be consumed by an explicit autonomous adapter, never cast to a human receipt.
 * No network, generation, secret lookup, or paid work occurs here.
 */
export function createAutonomousDataAdmission(config: {
  policy: AutonomousDataPolicy;
  operations: DataOperationLedger;
  /** Current server authorization; checked even for cached decisions. */
  authorizeTenant(tenantId: string, jobId: string): Promise<boolean>;
  knownSecrets?: readonly string[] | (() => readonly string[]);
}) {
  const policy = structuredClone(config.policy);
  if (policy.schemaVersion !== 'autonomous-data-policy-v1' || !id(policy.version) || !id(policy.tenantId)
    || !id(policy.checker.principalId) || !id(policy.checker.version) || !validTime(policy.deadline)
    || ![policy.maxSourceCycles, policy.maxGenerationCycles].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 5)
    || new Set(policy.sources.map(s => s.sourceId)).size !== policy.sources.length
    || policy.sources.some(s => !id(s.sourceId) || !id(s.producerId) || !https(s.url)
      || !/^[a-f0-9]{64}$/.test(s.contentHash) || !id(s.evidenceReceiptId) || !id(s.permissionReceiptId)
      || !validTime(s.expiresAt) || !s.allowedUses.length || s.allowedUses.some(u => !['evaluation', 'generation', 'redistribution'].includes(u)))
    || policy.facts.some(f => !policy.sources.some(s => s.sourceId === f.sourceId)
      || !f.question.trim() || !f.answer.trim() || !f.excerpt.includes(f.answer))
    || policy.expert && (!id(policy.expert.recipientId) || !id(policy.expert.consentPolicyId))) throw new Error('invalid_autonomous_data_policy');
  const policyDigest = reviewDigest(policy);
  const permissionDigest = reviewDigest(policy.sources.map(({ sourceId, permissionReceiptId, allowedUses, expiresAt }) => ({ sourceId, permissionReceiptId, allowedUses, expiresAt })));
  const secrets = () => typeof config.knownSecrets === 'function' ? config.knownSecrets() : config.knownSecrets ?? [];
  const screen = (value: unknown) => { if (!inspectDataSafety(value, secrets()).safe) throw new Error('unsafe_autonomous_data'); };
  return {
    async admit(raw: AutonomousDataRequest): Promise<AutonomousDataDecision> {
      const input = structuredClone(raw);
      if (input.tenantId !== policy.tenantId || !await config.authorizeTenant(input.tenantId, input.task.jobId)) throw new Error('autonomous_data_unauthorized');
      screen({ input, policy });
      if (!id(input.task.jobId) || !id(input.task.taskId) || !id(input.task.targetId) || !validTime(input.now)
        || !Number.isSafeInteger(input.cycle) || input.cycle < 0
        || input.cycle > policy.maxSourceCycles + policy.maxGenerationCycles
        || !input.task.requirements.length || input.task.requirements.some(r => !id(r.id) || !Number.isSafeInteger(r.minimumCases) || r.minimumCases < 1)
        || new Set(input.task.requirements.map(r => r.id)).size !== input.task.requirements.length) throw new Error('invalid_autonomous_data_request');
      const contextDigest = reviewDigest({ task: input.task, context: input.context });
      // now is checked afresh on every replay. It is not part of stable decision identity.
      const requestDigest = reviewDigest({ schema: 'autonomous-data-request-v1', tenantId: input.tenantId,
        task: input.task, context: input.context, candidates: input.candidates, cycle: input.cycle, policyDigest, permissionDigest });
      const key = `autonomous-data:${input.tenantId}:${input.task.jobId}:${input.task.taskId}:${input.cycle}`;
      const base = { authority: 'automated_data_policy_v1' as const, policyVersion: policy.version, policyDigest,
        checker: policy.checker, requestDigest, contextDigest, permissionDigest,
        cost: { status: 'known' as const, microUsd: 0 as const } };
      const reasons: string[] = [];
      const approvedCaseIds: string[] = [];
      const approvedFacts: AutonomousDataDecision['approvedFacts'] = [];
      const sources = new Map(input.candidates.sources.map(s => [s.id, s]));
      const permitted = new Set<string>();
      for (const source of input.candidates.sources) {
        const authorized = policy.sources.find(s => s.sourceId === source.id);
        if (!authorized || input.candidates.sources.filter(s => s.id === source.id).length !== 1
          || authorized.url !== source.url || authorized.producerId !== source.provenance.producerId
          || source.provenance.origin === 'synthetic' || source.provenance.origin === 'evaluation_target'
          || authorized.producerId === input.task.targetId || authorized.producerId === policy.checker.principalId
          || Date.parse(authorized.expiresAt) <= Date.parse(input.now)
          || authorized.contentHash !== createHash('sha256').update(source.content).digest('hex')
          || !(input.task.requiredUses ?? ['evaluation']).every(u => authorized.allowedUses.includes(u))) {
          reasons.push('source_not_authorized_or_expired'); continue;
        }
        // Candidate license/review/consent labels confer no authority, even if they say approved.
        permitted.add(source.id);
      }
      for (const candidate of input.candidates.cases) {
        if (!id(candidate.id) || input.candidates.cases.filter(c => c.id === candidate.id).length !== 1
          || !candidate.input.trim() || !candidate.requirementIds.length
          || candidate.requirementIds.some(r => !input.task.requirements.some(req => req.id === r))
          || candidate.generatorId === policy.checker.principalId || candidate.generatorId === input.task.targetId
          || candidate.synthetic && !candidate.generatorId
          || !candidate.sourceIds.length || candidate.sourceIds.some(s => !permitted.has(s))) {
          reasons.push('case_identity_coverage_or_independence_invalid'); continue;
        }
        const fact = policy.facts.find(f => f.question === candidate.input && f.answer === candidate.expectedAnswer
          && candidate.sourceIds.includes(f.sourceId) && permitted.has(f.sourceId)
          && sources.get(f.sourceId)!.content.includes(f.excerpt)
          && sources.get(f.sourceId)!.provenance.producerId !== candidate.generatorId);
        if ((input.task.factualAnswersRequired || candidate.expectedAnswer !== undefined) && !fact) {
          reasons.push('fact_not_independently_verified'); continue;
        }
        approvedCaseIds.push(candidate.id);
        if (fact) approvedFacts.push({ caseId: candidate.id, answer: fact.answer, sourceIds: [fact.sourceId] });
      }
      const sufficient = input.task.requirements.every(req => input.candidates.cases.filter(c => approvedCaseIds.includes(c.id) && c.requirementIds.includes(req.id)).length >= req.minimumCases);
      const expired = Date.parse(policy.deadline) <= Date.parse(input.now);
      let status: AutonomousDataDecision['status'];
      if (!policy.enabled) { status = 'not_assessed'; reasons.push('autonomous_policy_disabled'); }
      else if (expired) { status = 'not_assessed'; reasons.push('data_deadline_exhausted'); }
      else if (sufficient) { status = 'ready'; reasons.push('deterministic_source_permission_fact_and_coverage_checks_passed'); }
      else if (input.cycle < policy.maxSourceCycles) { status = 'acquire_sources'; reasons.push('bounded_source_cycle_available'); }
      else if (input.cycle < policy.maxSourceCycles + policy.maxGenerationCycles) { status = 'generate'; reasons.push('bounded_generation_cycle_available'); }
      else if (policy.expert?.approved) { status = 'wait_external'; reasons.push('configured_consented_expert_response_required'); }
      else { status = 'not_assessed'; reasons.push('insufficient_evidence_cycles_exhausted'); }
      const decision: AutonomousDataDecision = { ...base, status,
        factualCorrectness: status === 'ready' && approvedFacts.length === approvedCaseIds.length ? 'assessed' : 'unassessed',
        approvedCaseIds: status === 'ready' ? approvedCaseIds : [], approvedFacts: status === 'ready' ? approvedFacts : [],
        reasons: [...new Set(reasons)], ...(status === 'wait_external' ? { expertRequest: {
          recipientId: policy.expert!.recipientId, consentPolicyId: policy.expert!.consentPolicyId, requestDigest,
        } } : {}) };
      screen(decision);
      const existing = await config.operations.get(key);
      if (existing && existing.digest !== requestDigest) throw new Error('autonomous_data_snapshot_conflict');
      if (existing?.state === 'complete') {
        screen(existing.result);
        const saved = existing.result as AutonomousDataDecision;
        // Expiry/revocation cannot be bypassed by replaying an older ready result.
        if (saved.requestDigest !== requestDigest || saved.policyDigest !== policyDigest) throw new Error('autonomous_data_receipt_invalid');
        if ((saved.status === 'ready' && decision.status !== 'ready') || (saved.status !== 'not_assessed' && (!policy.enabled || expired))) throw new Error('autonomous_data_authority_expired');
        return structuredClone(saved);
      }
      // Pure checks can be recomputed after a crash; completion requires identical digest/result.
      await config.operations.claim(key, requestDigest);
      await config.operations.complete(key, requestDigest, decision);
      return structuredClone(decision);
    },
  };
}
