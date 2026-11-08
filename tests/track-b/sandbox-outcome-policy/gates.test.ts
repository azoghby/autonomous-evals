import { describe, expect, it } from 'vitest';
import { runScenarioGates, createSuiteGateArtifact, gateDigest, type ExecutionOutcome } from '../../../packages/core/src/evals/sandbox/generation/gates';
import { gateFixture } from '../sandbox-integration/sql-fixtures';

describe('versioned gate execution cost policy (§10)', () => {
  it('admits real SQL oracle/null controls/mutations with unknown monetary telemetry and retains null', async () => {
    const f = await gateFixture();
    try {
      const execute = f.ports.execute;
      f.ports.execute = async input => ({ ...await execute(input), costMicroUsd: null });
      const evidence = await runScenarioGates(f.input, f.ports);
      expect(evidence.status).toBe('passed');
      expect(evidence.executionRule).toBe('sandbox-gate-execution-v2');
      expect(evidence.runs.find(r => r.role === 'oracle')?.execution.costMicroUsd).toBeNull();
      expect(evidence.mutations.every(m => m.execution.costMicroUsd === null)).toBe(true);
      expect(createSuiteGateArtifact({ scope: f.input.scope, environment: f.input.environment,
        scenarios: [f.s], evidence: [evidence] }).evidence[0]).toEqual(evidence);
      expect(await runScenarioGates(f.input, f.ports)).toEqual(evidence);
      await expect(runScenarioGates({ ...f.input, qualityCostPolicy: {
        version: 'sandbox-quality-cost-policy-v1', maxCostMicroUsd: 10,
      } }, f.ports)).rejects.toThrow();
      // Removing a v2 rule cannot relabel unknown-money evidence as historical evidence.
      const legacy = structuredClone(evidence);
      delete legacy.executionRule;
      const { digest: _, ...body } = legacy;
      legacy.digest = gateDigest(body);
      expect(() => createSuiteGateArtifact({ scope: f.input.scope, environment: f.input.environment,
        scenarios: [f.s], evidence: [legacy] })).toThrow();
    } finally { await f.close(); }
  }, 30000);

  it('preserves validation and identity of historical known-money gate artifacts', async () => {
    const f = await gateFixture();
    try {
      const evidence = await runScenarioGates(f.input, f.ports);
      delete evidence.executionRule;
      evidence.bindingDigest = gateDigest({ environment: f.input.environment, scenario: f.s,
        scope: f.input.scope, versions: f.input.versions });
      const { digest: _, ...body } = evidence;
      evidence.digest = gateDigest(body);
      const artifact = createSuiteGateArtifact({ scope: f.input.scope, environment: f.input.environment,
        scenarios: [f.s], evidence: [evidence] });
      expect(artifact.evidence[0]).toEqual(evidence);
      expect(artifact.evidence[0].executionRule).toBeUndefined();
    } finally { await f.close(); }
  }, 30000);

  it.each([
    ['negative cost', { costMicroUsd: -1 }],
    ['fractional cost', { costMicroUsd: 0.1 }],
    ['unknown execution', { status: 'unknown' }],
    ['failed execution', { status: 'failed' }],
  ] as const)('refuses %s even without quality budget', async (_label, patch) => {
    const f = await gateFixture();
    try {
      const execute = f.ports.execute;
      f.ports.execute = async input => ({ ...await execute(input), ...patch } as ExecutionOutcome);
      expect((await runScenarioGates(f.input, f.ports)).status).toBe('unresolved');
    } finally { await f.close(); }
  }, 30000);

  it('keeps explicit budget with missing measured cost unresolved', async () => {
    const f = await gateFixture();
    try {
      const execute = f.ports.execute;
      f.ports.execute = async input => ({ ...await execute(input), costMicroUsd: null });
      const evidence = await runScenarioGates({ ...f.input, qualityCostPolicy: {
        version: 'sandbox-quality-cost-policy-v1', maxCostMicroUsd: 10,
      } }, f.ports);
      expect(evidence.status).toBe('unresolved');
      expect(evidence.reasons).toContain('oracle:incomplete_execution_or_grade');
    } finally { await f.close(); }
  }, 30000);
});
