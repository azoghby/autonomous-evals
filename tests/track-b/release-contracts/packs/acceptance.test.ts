import { expect, it, vi } from 'vitest';
import { createComparisonMonitoringService, compareRichChecks, richChecks } from '../src/monitoring/composition';
import { createRetainedComparisonAdapter } from '../src/monitoring/adapters';
import type { TextCheckpointStore } from '../src/evals/integration/checkpoints';
import { createDurableProgressProjection } from '../src/reporting/chat/projection';
import { renderReport } from '../src/reporting/render';
import { fromScenario, renderRedTeamTurns } from '../src/redteam/select';
import { artifact, appended, ctx, frozen, ids, packIds, time } from './fixtures';
import { progressFixture, reportInput } from './fixtures';

it('Acceptance: pinned append produces eight library-backed cases with actual attack turns', () => {
  expect(packIds).toHaveLength(8); expect(ids).toHaveLength(20); expect(new Set(ids).size).toBe(20);
  for (const s of appended.scenarios.filter(s => s.id.startsWith('rt_'))) {
    expect(fromScenario(s)?.id).toBe(s.id); expect(renderRedTeamTurns(s).length).toBeGreaterThan(0);
    expect(s.checks[0].spec.redteam).toBeDefined();
  }
});
for (const mode of ['comparison', 'monitoring'] as const) {
  it.each(['full_appended', 'one_appended', 'duplicate', 'replaced'] as const)(`Acceptance: ${mode} rejects %s inventory before any claim or dispatch`, async mutation => {
    const claim = vi.fn(async () => { throw Error('No durable intent is allowed'); });
    const checkpoints: TextCheckpointStore = { claim, get: vi.fn(), complete: vi.fn(), markAmbiguous: vi.fn(), release: vi.fn() };
    const dispatch = vi.fn(async () => artifact());
    let scenarioIds = [...ids];
    if (mutation === 'one_appended') scenarioIds = [...frozen.scenarios.map(s => s.id), packIds[0]];
    if (mutation === 'duplicate') scenarioIds = [...frozen.scenarios.map(s => s.id), frozen.scenarios[0].id];
    if (mutation === 'replaced') scenarioIds = [...frozen.scenarios.slice(1).map(s => s.id), packIds[0]];
    const adapter = { getSuite: vi.fn(async () => frozen), execute: dispatch };
    const service = createComparisonMonitoringService({ checkpoints, resolve: async () => ({ tenantId: 'local', jobId: frozen.jobId,
      environment: 'test', isFixture: true, suite: frozen, scenarioIds,
      baseline: { version: 'v1', targetId: 'local-before', branchId: null, adapter: mode === 'monitoring' ? createRetainedComparisonAdapter(artifact()) : adapter },
      current: { version: 'v2', targetId: 'local-after', branchId: null, adapter } }) });
    await expect(service.compare(ctx, { operationId: 'pack-inventory', baselineVersion: 'v1', currentVersion: 'v2', mode })).rejects.toMatchObject({ code: 'rejected_input', retryable: false });
    expect(claim).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(adapter.getSuite).not.toHaveBeenCalled();
  });
}
it.each(['missing', 'duplicate'] as const)('Acceptance: rich evidence rejects %s engine scenarios', mutation => {
  const a = artifact();
  if (a.kind !== 'text') throw Error('fixture');
  if (mutation === 'missing') a.run.executions.pop(); else a.run.executions.push(a.run.executions[0]);
  expect(() => richChecks(a)).toThrow();
});
it('Acceptance: check comparison rejects a dropped appended case rather than comparing the intersection', () => {
  const checks = ids.map(scenarioId => ({ scenarioId, checkId: 'check', outcome: 'passed' as const, evidenceIds: ['local'] }));
  expect(() => compareRichChecks(checks, checks.filter(c => !c.scenarioId.startsWith('rt_')))).toThrow();
});
it('Acceptance: progress rejects base-only evidence against complete appended inventory', async () => {
  const f = progressFixture(); f.plan.checkpoints[0].scenarioIds = ids;
  await expect(createDurableProgressProjection(f.ports).project(f.scope)).rejects.toMatchObject({ code: 'invalid_snapshot' });
});
it('Acceptance: progress rejects an unsupported pack checkpoint format before reading', async () => {
  const f = progressFixture(); Object.assign(f.plan.checkpoints[0], { format: 'pack_run' });
  await expect(createDurableProgressProjection(f.ports).project(f.scope)).rejects.toMatchObject({ code: 'invalid_snapshot' });
  expect(f.ports.reader.read).not.toHaveBeenCalled();
});
it('Acceptance: explicit unresolved report status suppresses the clean conclusion in all exports', () => {
  const out = renderReport({ ...reportInput(), evaluationStatus: 'unresolved' });
  expect(out.summary).toContain('No product conclusion is available');
  expect(out.markdown).not.toContain('No problems were found'); expect(out.html).not.toContain('No problems were found');
});
