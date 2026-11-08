import { createHash } from 'node:crypto';
import { type AutonomousDataPolicy, type AutonomousDataRequest } from '../../../packages/core/src/evals/data/autonomy';
import type { DataOperation, DataOperationLedger } from '../../../packages/core/src/evals/data/operation-ledger';
import { reviewDigest } from '../../../packages/core/src/evals/data/binding';

// Shared durable adapter is exercised on real SQL by the combined acceptance harness.
export function memoryDataLedger(): DataOperationLedger {
  const records = new Map<string, DataOperation>();
  return {
    async get(key) { return structuredClone(records.get(key) ?? null); },
    async claim(key, digest) {
      const old = records.get(key);
      if (old && old.digest !== digest) throw new Error('conflict');
      if (old) return { claimed: false, record: structuredClone(old) };
      const record: DataOperation = { key, digest, state: 'pending' }; records.set(key, record);
      return { claimed: true, record: structuredClone(record) };
    },
    async complete(key, digest, result) {
      const old = records.get(key);
      if (!old || old.digest !== digest || old.state === 'complete' && reviewDigest(old.result) !== reviewDigest(result)) throw new Error('conflict');
      records.set(key, { key, digest, state: 'complete', result: structuredClone(result) });
    },
  };
}
export function dataFixture() {
  const content = 'The launch code is maple.';
  const hash = createHash('sha256').update(content).digest('hex');
  const policy: AutonomousDataPolicy = {
    schemaVersion: 'autonomous-data-policy-v1', version: 'data_v1', enabled: true, tenantId: 'tenant_a',
    checker: { principalId: 'deterministic_checker', version: 'checker_v1' },
    sources: [{ sourceId: 'source_one', url: 'https://fixtures.example/reference', contentHash: hash,
      producerId: 'reference_service', evidenceReceiptId: 'retrieval_one', permissionReceiptId: 'permission_one',
      allowedUses: ['evaluation'], expiresAt: '2030-01-01T00:00:00Z' }],
    facts: [{ sourceId: 'source_one', question: 'What is the launch code?', answer: 'maple', excerpt: content }],
    maxSourceCycles: 1, maxGenerationCycles: 1, deadline: '2029-01-01T00:00:00Z',
  };
  const request: AutonomousDataRequest = {
    tenantId: 'tenant_a', cycle: 0, now: '2026-11-07T00:00:00Z', context: { agentVersion: 'target_v1' },
    task: { taskId: 'task_a', jobId: 'job_a', description: 'Launch reference', requirements: [{ id: 'factual', description: 'Factual answer', minimumCases: 1 }], factualAnswersRequired: true, targetId: 'target_agent' },
    candidates: {
      sources: [{ id: 'source_one', url: policy.sources[0]!.url, content,
        license: { name: 'UNTRUSTED', url: 'https://fixtures.example/license', permission: 'unknown', allowedUses: [] },
        provenance: { origin: 'customer', producerId: 'reference_service', retrievedAt: '2026-11-07T00:00:00Z', contentHash: hash },
        review: { status: 'pending', reviewerId: '', reviewedAt: '', notes: '' } }],
      cases: [{ id: 'case_one', input: 'What is the launch code?', requirementIds: ['factual'], synthetic: true, generatorId: 'engineer_v1', sourceIds: ['source_one'], expectedAnswer: 'maple' }],
    },
  };
  return { policy, request };
}
