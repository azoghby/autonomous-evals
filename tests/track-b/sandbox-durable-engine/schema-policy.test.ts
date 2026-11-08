import { it, expect } from 'vitest';
import { EnvironmentSpec, SandboxScenario } from '../../../packages/core/src/sandbox/spec';
import { executionDigest } from '../../../packages/core/src/evals/sandbox/execution/runner';
import { validatePrivateReport } from '../../../packages/core/src/evals/sandbox/persistence/schema';

function legacy() {
  const environment = EnvironmentSpec.parse({ specVersion: 'sandbox-spec-v1', id: 'env_a', name: 'Acme', domain: 'support',
    tools: [{ name: 'lookup', description: 'Read', inputSchema: { type: 'object' }, effect: 'read', binding: { kind: 'sql', statements: ['SELECT 1'] }, source: 'test' }],
    state: { ddl: 'CREATE TABLE x(id int)', seedSql: '' }, workflows: [{ id: 'support', name: 'Support', description: 'Support', tools: ['lookup'] }],
    integration: { mode: 'tool_loop', endpointUrl: 'https://example.com/v1/chat/completions', model: 'agent' } });
  const scenario = SandboxScenario.parse({ id: 'sx_quote', workflowId: 'support', title: 'Quote', category: 'happy_path', persona: { name: 'User', goal: 'Quote', knowledge: [], style: '' } });
  const versions = { spec: 'sandbox-spec-v1', envHash: executionDigest(environment), suiteHash: executionDigest('suite'), simulatorModel: 'sim', judgeModel: 'judge', runtime: 'runtime' };
  const input = { jobId: 'job', trialId: 'trial', trial: 0, variant: 'base', seed: 1, environment, scenario, versions, agentModel: 'agent', agentConfigDigest: 'agent', simulatorConfigDigest: 'sim',
    bounds: { maxTurns: 1, maxAgentSteps: 1, maxToolCalls: 1, maxTranscriptBytes: 1000, timeoutMs: 1000, cleanupTimeoutMs: 1000, budgetMicroUsd: 1 } };
  const money = { status: 'unknown', microUsd: null };
  return { schema: 'sandbox-private-report-v1', suiteDigest: executionDigest('suite'), approvalId: 'approval',
    execution: { schema: 'sandbox-execution-v1', identityDigest: executionDigest(input), input, status: 'unresolved', reason: 'pending', runId: null, worldId: null, transcript: [], toolCalls: [], diff: null, outbox: null,
      cleanup: { run: 'not_created', world: 'not_created' }, grading: 'not_run', money, infrastructure: 'unknown', elapsedMs: 0 }, grade: null,
    outcome: { scenarioId: scenario.id, trial: 0, seed: '1', fixtureHash: 'historic-fixture', variant: 'base', agentVersion: 'historic-agent', versions, status: 'unknown', failureAttribution: 'unknown' }, unresolved: ['cost_unsettled'], money };
}
it('retains exact legacy report JSON and does not add optional media or policy fields', () => {
  const report = legacy();
  expect(JSON.stringify(validatePrivateReport(report, 'job'))).toBe(JSON.stringify(report));
});
for (const qualityCostPolicy of [null, { version: 'sandbox-quality-cost-policy-v1', maxCostMicroUsd: 100 }]) {
  it(`validates complete policy metadata (${qualityCostPolicy ? 'cap' : 'no cap'})`, () => {
    const metadata = { outcomeRule: 'sandbox-quality-outcome-v2', qualityCostPolicy };
    const report = { ...legacy(), ...metadata, policyDigest: executionDigest(metadata) };
    expect(validatePrivateReport(report, 'job')).toEqual(report);
    expect(() => validatePrivateReport({ ...report, policyDigest: executionDigest('changed') }, 'job')).toThrow('policy_identity_conflict');
    for (const key of Object.keys(metadata).concat('policyDigest')) {
      const partial: Record<string, unknown> = { ...report }; delete partial[key];
      expect(() => validatePrivateReport(partial, 'job')).toThrow();
    }
    expect(() => validatePrivateReport({ ...report, qualityCostPolicy: { version: 'sandbox-quality-cost-policy-v1', maxCostMicroUsd: -1 } }, 'job')).toThrow();
  });
}
it('rejects unknown metadata/report fields instead of passing unknown objects through', () => {
  expect(() => validatePrivateReport({ ...legacy(), policy: {} }, 'job')).toThrow();
  expect(() => validatePrivateReport({ ...legacy(), media: { kind: 'receipt', artifact: {} } }, 'job')).toThrow();
});
