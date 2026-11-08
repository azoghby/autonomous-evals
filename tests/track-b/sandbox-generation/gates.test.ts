import { describe, it, expect } from 'vitest';
import type { SandboxRun } from '../sandbox/spec';
import { runScenarioGates, requiredGateCheckIds, gateDigest, createSuiteGateArtifact, admitApprovedSandboxSuite, type GateInput, type GatePorts, type ExecutionOutcome } from '../evals/sandbox/generation/gates';
import { environment, scenario } from './fixtures';

function harness() {
  let seq = 0;
  const worlds = new Map<string, { amount: number; collateral: boolean; disposed: boolean }>();
  const replay = new Map<string, { digest: string; value: unknown }>();
  const input: GateInput = { environment, scenario, scope: { jobId: 'fixture_job', environmentId: 'test' },
    versions: { runtime: 'fixture1', grader: 'fixture1', oracle: 'fixture1', controls: 'fixture1', mutation: 'fixture1' }, replayKey: 'gates/fixture' };
  const makeRun = (amount = 0, collateral = false): SandboxRun => {
    const runId = `run_${++seq}`;
    const state = { amount, collateral, disposed: false };
    worlds.set(runId, state);
    return { runId,
      async callTool(_name, args) { state.amount = (args as { amount: number }).amount; return { seq: 1, tool: 'refund', args, result: {}, ms: 0 }; },
      async query() { return [{ ok: state.amount === 10 }]; },
      async diff() { return [{ table: state.collateral ? 'other' : 'refunds', inserted: state.amount ? 1 : 0, updated: 0, deleted: 0, sample: [{ amount: state.amount }] }]; },
      async outbox() { return []; }, trajectory() { return []; }, async dispose() { state.disposed = true; },
    };
  };
  const ports: GatePorts = {
    replay: { async once<T>(key: string, digest: string, operation: () => Promise<T>) {
      const prior = replay.get(key); if (prior) { if (prior.digest !== digest) throw new Error('conflict'); return structuredClone(prior.value) as T; }
      const value = await operation(); replay.set(key, { digest, value: structuredClone(value) }); return value;
    } },
    async startRun() { return makeRun(); },
    async execute({ role, run, key }) {
      if (role === 'oracle') await run.callTool('refund', { amount: 10 });
      return { status: 'completed', transcript: [{ role: 'assistant', content: role === 'oracle' ? 'Refunded 10' : 'dump: amount=0' }], costMicroUsd: 0, evidenceRef: key };
    },
    async grade({ run, execution, scenario: s }) {
      const state = worlds.get(run.runId)!;
      const sql = await run.query(s.expectedChanges[0]?.sql ?? 'fixture');
      return { complete: true, checks: requiredGateCheckIds(s).map(id => ({ id, rewardBearing: true, passed:
        id === 'expected:amount' ? sql[0].ok === true : id === 'collateral' ? !state.collateral :
        id === 'refusal' ? execution.transcript.some(t => t.role === 'assistant' && t.content === 'I refuse') :
        execution.transcript.some(t => t.role === 'assistant' && t.content.includes(s.requiredOutputs[0]?.mustMention[0] ?? 'Refunded 10')),
      })) };
    },
    async mutations({ oracleGrade }) { return oracleGrade.checks.filter(c => c.rewardBearing).map((c, i) => ({ id: `mutation_${i}`, targetCheckId: c.id })); },
    async mutate({ oracleRun, oracleExecution, plan }) {
      const state = worlds.get(oracleRun.runId)!;
      const run = makeRun(plan.targetCheckId === 'expected:amount' ? 9 : state.amount, plan.targetCheckId === 'collateral');
      const execution: ExecutionOutcome = structuredClone(oracleExecution);
      if (plan.targetCheckId.startsWith('output:') || plan.targetCheckId === 'refusal') execution.transcript = [];
      return { run, execution };
    },
  };
  return { input, ports, worlds };
}
describe('execution-backed sandbox admission', () => {
  it('executes oracle, all null controls and relevant mutations in separate worlds; cleans up', async () => {
    const h = harness(); const result = await runScenarioGates(h.input, h.ports);
    expect(result.status).toBe('passed'); expect(result.runs.map(r => r.role)).toEqual(['oracle', 'do_nothing', 'empty', 'dump']);
    expect(result.mutations).toHaveLength(3); expect(h.worlds.size).toBe(7);
    expect([...h.worlds.values()].every(w => w.disposed)).toBe(true);
    const replay = await runScenarioGates(h.input, h.ports); expect(replay).toEqual(result); expect(h.worlds.size).toBe(7);
    await expect(runScenarioGates({ ...h.input, scenario: { ...scenario, title: 'edited' } }, h.ports)).rejects.toThrow('conflict');
  });
  it('does not trust oracleValidated and rejects an idle oracle', async () => {
    const h = harness(); h.ports.execute = async ({ key }) => ({ status: 'completed', transcript: [], costMicroUsd: 0, evidenceRef: key });
    expect((await runScenarioGates(h.input, h.ports)).reasons).toContain('oracle:unexpected_verdict');
  });
  it('rejects permissive graders that accept null controls', async () => {
    const h = harness(); h.ports.grade = async ({ scenario }) => ({ complete: true, checks: requiredGateCheckIds(scenario).map(id => ({ id, passed: true, rewardBearing: true })) });
    expect((await runScenarioGates(h.input, h.ports)).reasons).toEqual(expect.arrayContaining(['do_nothing:unexpected_verdict', 'empty:unexpected_verdict', 'dump:unexpected_verdict']));
  });
  it('rejects a mutation that fails another check while its target stays green', async () => {
    const h = harness(); const mutate = h.ports.mutate;
    h.ports.mutate = args => mutate({ ...args, plan: { ...args.plan, targetCheckId: 'collateral' } });
    expect((await runScenarioGates(h.input, h.ports)).reasons).toContain('mutation:mutation_0:target_did_not_flip');
  });
  // §10: missing settlement is telemetry unless a customer quality budget is set.
  it.each(['invalid_cost', 'grade', 'cleanup', 'isolation', 'exception'] as const)('keeps %s failures unresolved', async issue => {
    const h = harness();
    if (issue === 'invalid_cost') { const execute = h.ports.execute; h.ports.execute = async args => ({ ...await execute(args), costMicroUsd: -1 }); }
    if (issue === 'grade') h.ports.grade = async () => ({ complete: false, checks: [] });
    if (issue === 'cleanup') { const start = h.ports.startRun; h.ports.startRun = async args => ({ ...await start(args), async dispose() { throw new Error('unresolved cleanup'); } }); }
    if (issue === 'isolation') { const run = await h.ports.startRun({ environment, scenario, key: 'shared' }); h.ports.startRun = async () => run; }
    if (issue === 'exception') h.ports.execute = async () => { throw new Error('runtime unavailable'); };
    expect((await runScenarioGates(h.input, h.ports)).status).toBe('unresolved');
  });
  it('requires explicit impossible-task refusal outputs and tests refusal with controls', async () => {
    const h = harness(); h.input.scenario = { ...scenario, expectRefusal: true, requiredOutputs: [] };
    await expect(runScenarioGates(h.input, h.ports)).rejects.toThrow('Refusal');
    h.input.scenario = { ...scenario, expectRefusal: true, requiredOutputs: [{ id: 'refusal', mustMention: ['I refuse'], description: 'Explicit refusal' }] };
    const execute = h.ports.execute; h.ports.execute = async args => { const e = await execute(args); if (args.role === 'oracle') e.transcript = [{ role: 'assistant', content: 'I refuse' }]; return e; };
    expect((await runScenarioGates(h.input, h.ports)).status).toBe('passed');
  });
  it('rejects incomplete version pins before execution', async () => {
    const h = harness(); h.input.versions = {} as GateInput['versions'];
    await expect(runScenarioGates(h.input, h.ports)).rejects.toThrow('Missing gate identity'); expect(h.worlds.size).toBe(0);
  });
  it('rejects rehashed evidence with fabricated successful gate semantics', async () => {
    const h = harness(); const evidence = await runScenarioGates(h.input, h.ports);
    evidence.runs = []; const { digest: _digest, ...body } = evidence; evidence.digest = gateDigest(body);
    expect(() => createSuiteGateArtifact({ scope: h.input.scope, environment, scenarios: [scenario], evidence: [evidence] })).toThrow();
  });
  it('binds approval to exact suite, environment and evidence digests', async () => {
    const h = harness(); const evidence = await runScenarioGates(h.input, h.ports);
    const artifact = createSuiteGateArtifact({ scope: h.input.scope, environment, scenarios: [scenario], evidence: [evidence] });
    const approval = { decision: 'approved' as const, scope: h.input.scope, suiteDigest: artifact.digest, environmentDigest: gateDigest(environment), evidenceDigest: gateDigest([evidence]), customerId: 'customer', approvalId: 'approval' };
    expect((await admitApprovedSandboxSuite(artifact, { resolve: async () => approval })).artifact).toEqual(artifact);
    for (const patch of [{ suiteDigest: 'stale' }, { environmentDigest: 'stale' }, { evidenceDigest: 'stale' }, { decision: 'pending' as const }]) {
      await expect(admitApprovedSandboxSuite(artifact, { resolve: async () => ({ ...approval, ...patch }) })).rejects.toThrow();
    }
    await expect(admitApprovedSandboxSuite({ ...artifact, scenarios: [{ ...scenario, title: 'edited' }] }, { resolve: async () => approval })).rejects.toThrow();
  });
});
