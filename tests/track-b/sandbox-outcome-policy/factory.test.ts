import { expect, it } from 'vitest';
import { createSandboxEngine, type EngineTrialRequest, type PrivateSandboxReport, type SandboxEngineConfig } from '../../../packages/core/src/evals/sandbox/integration';
import { gateDigest, type CustomerSuiteApproval } from '../../../packages/core/src/evals/sandbox/generation/gates';
import { projectTrial } from '../../../packages/core/src/evals/sandbox/grading';
import { freezeSandboxInputs } from '../../../packages/core/src/evals/sandbox/identity';
import { environment, gateFixture, scenario, trialInput, versions } from '../sandbox-integration/sql-fixtures';
import { gateReplay, SqlRuntime } from '../sandbox-integration/sql-world';

it('actual SQL factory separates proven quality from held spend, binds approved cost policy and excludes unattributed failures', async () => {
  const f = await gateFixture(), runtime = new SqlRuntime();
  let approval: CustomerSuiteApproval | null = null;
  let dispatches = 0, admitted = true, complete = true, text = '47', broken = false;
  const reservations: unknown[] = [], persisted: PrivateSandboxReport[] = [];
  const config: SandboxEngineConfig = {
    scope: f.input.scope,
    generation: {
      job: { jobId: 'sql-job', customerId: 'customer', package: 'workflow_eval', environment: 'test', isFixture: true, quoteVersion: null, linkedRetestOf: null },
      // This test executes the actual factory's proposal/run path without agent generation.
      runner: { runTask: async () => { throw new Error('generation_not_requested'); } } as unknown as SandboxEngineConfig['generation']['runner'],
      sessionCapMicroUsd: 10, jobCapMicroUsd: 100,
      bindOperation: async () => 'bound', onMeasuredCost: async () => undefined,
    },
    gateVersions: f.input.versions, gateEvalVersions: versions(), gates: f.ports,
    gateEvidence: async ({ run }) => ({ completeDiff: { runId: run.runId, allTables: true } }),
    approvals: { resolve: async () => approval },
    execution: {
      runtime, checkpoints: f.storage.store,
      authorizeTrial: async input => { reservations.push(input); return admitted; },
      simulator: { model: 'offline-sim-v1', configDigest: 'offline-sim-config-v1', next: async ({ turn }) => ({ content: 'Quote order 1', disposition: turn === 0 ? 'continue' : 'goal_achieved', disclosedFactIndices: [] }) },
      target: () => ({ model: 'offline-agent-v1', configDigest: 'offline-agent-config-v1', complete: async () => {
        dispatches++;
        if (broken) throw new Error('unknown_infrastructure');
        return { content: dispatches % 2 ? '' : text, toolCalls: dispatches % 2 ? [{ id: `lookup-${dispatches}`, name: 'lookup', args: {} }] : [], usage: null, money: { status: 'unknown' } };
      } }),
    },
    authority: {
      authorize: async () => true, replay: gateReplay(f.storage.store),
      finalSnapshot: async execution => {
        const snapshot = runtime.snapshots.get(execution.runId!)!;
        return { run: { runId: execution.runId!, query: snapshot.query.bind(snapshot), diff: snapshot.diff.bind(snapshot), trajectory: snapshot.trajectory.bind(snapshot) },
          evidence: { completeDiff: { runId: complete ? execution.runId! : 'incomplete-snapshot', allTables: true } }, release: async () => undefined };
      },
      persistPrivateReport: async report => { persisted.push(report); },
    },
  };
  try {
    const engine = createSandboxEngine(config);
    const artifact = await engine.propose({ environment, scenarios: [scenario()], operationKey: 'quality-policy' });
    approval = { decision: 'approved', suiteDigest: artifact.digest, environmentDigest: gateDigest(artifact.environment), evidenceDigest: gateDigest(artifact.evidence), scope: artifact.scope, customerId: 'customer', approvalId: 'approved-policy' };
    const request = (id: string): EngineTrialRequest => {
      const { environment: _e, scenario: _s, versions: _v, jobId: _j, ...trial } = trialInput(id);
      return { artifact, versions: { ...versions(), suiteHash: freezeSandboxInputs(environment, artifact.scenarios).suiteHash }, trial: { ...trial, scenarioId: artifact.scenarios[0].id } };
    };
    const passed = await engine.run(request('quality-pass'));
    expect(passed.grade?.verdict).toBe('pass');
    expect(passed.outcome.status).toBe('pass');
    expect(passed.outcome.failureAttribution).toBeUndefined();
    expect(passed.money).toEqual({ status: 'unknown', microUsd: null });
    expect(passed.execution.money.microUsd).toBeNull();
    expect(projectTrial(passed.grade!, { trial: passed.outcome.trial, variant: passed.outcome.variant, versions: passed.grade!.versions,
      transcript: passed.grade!.transcript, costMicroUsd: passed.money.microUsd })).toMatchObject({ ok: false, reason: expect.stringContaining('zero must never be fabricated') });
    const legacy = structuredClone(passed);
    delete legacy.outcomeRule; delete legacy.qualityCostPolicy; delete legacy.policyDigest;
    legacy.outcome = { ...legacy.outcome, status: 'unknown', failureAttribution: 'unknown' };
    expect(engine.summarize([legacy], 1)).toMatchObject({ eligible: 0, excluded: { unknown: 1 } });
    expect(() => engine.summarize([passed, legacy], 2)).toThrow('outcome_policy_mismatch');
    expect(passed.unresolved).not.toContain('cost_unsettled');
    expect(engine.summarize([passed], 1)).toMatchObject({ eligible: 1, passed: 1, passRate: 1, allK: true });
    expect(engine.summarize([passed], 1).ci95).not.toBeNull();
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ budgetMicroUsd: 1 });
    expect(await createSandboxEngine(config).run(request('quality-pass'))).toEqual(passed);
    expect(dispatches).toBe(2);

    approval = { ...approval, qualityCostPolicy: { version: 'sandbox-quality-cost-policy-v1', maxCostMicroUsd: 1 } };
    // Changing a trusted policy under the same trial id must fail before any redispatch.
    await expect(createSandboxEngine(config).run(request('quality-pass'))).rejects.toThrow(/conflict/);
    expect(dispatches).toBe(2);
    const capped = await createSandboxEngine(config).run(request('quality-cap'));
    expect(capped.grade?.verdict).toBe('pass');
    expect(capped.outcome.status).toBe('unknown');
    expect(capped.unresolved).toContain('cost_unsettled');
    expect(capped.money.microUsd).toBeNull();
    expect(engine.summarize([capped], 1)).toMatchObject({ eligible: 0, excluded: { unknown: 1 }, passRate: null });
    expect(() => engine.summarize([passed, capped], 2)).toThrow('outcome_policy_mismatch');
    const beforeInvalid = dispatches;
    approval = { ...approval, qualityCostPolicy: { version: 'sandbox-quality-cost-policy-v1', maxCostMicroUsd: -1 } };
    await expect(createSandboxEngine(config).run(request('quality-invalid-policy'))).rejects.toThrow(/policy/);
    expect(dispatches).toBe(beforeInvalid);
    approval = { ...approval, qualityCostPolicy: { version: 'sandbox-quality-cost-policy-v1', maxCostMicroUsd: 1 } };
    // Extra HTTP-like request fields cannot strip the trusted resolver's budget.
    const hostile = { ...request('quality-http'), qualityCostPolicy: null };
    expect((await createSandboxEngine(config).run(hostile)).outcome.status).toBe('unknown');

    delete approval.qualityCostPolicy;
    text = 'Wrong amount';
    const failed = await createSandboxEngine(config).run(request('quality-fail'));
    expect(failed.grade?.verdict).toBe('fail');
    expect(failed.outcome.status).toBe('fail');
    expect(failed.outcome.failureAttribution).toBe('unknown');
    expect(engine.summarize([failed], 1)).toMatchObject({ eligible: 0, agentFailures: 0, excluded: { unknown: 1 } });
    text = '47'; complete = false;
    const incomplete = await createSandboxEngine(config).run(request('quality-incomplete'));
    expect(incomplete.outcome.status).toBe('unknown');
    expect(engine.summarize([incomplete], 1).eligible).toBe(0);
    complete = true; broken = true;
    const uncertain = await createSandboxEngine(config).run(request('quality-infrastructure'));
    expect(uncertain.execution.infrastructure).toBe('unknown');
    expect(uncertain.outcome.status).toBe('unknown');
    const beforeDenied = dispatches;
    admitted = false;
    const denied = await createSandboxEngine(config).run(request('quality-spend-denied'));
    expect(denied.execution.reason).toBe('budget_denied');
    expect(denied.outcome.status).toBe('unknown');
    expect(dispatches).toBe(beforeDenied);
    expect(persisted.length).toBeGreaterThan(0);
  } finally { await runtime.close(); await f.close(); }
}, 120000);
