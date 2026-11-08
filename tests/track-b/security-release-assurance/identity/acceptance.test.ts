import { afterEach, describe, expect, it } from 'vitest';
import { createPostgresEvaluationDataStore } from '../../../../packages/core/src/evals/data/postgres-store';
import { fixtureTask } from '../../../../packages/core/src/evals/data/adapters/fixtures';
import { database, digestA, digestB, plan, projector, runValue, save, scope } from './helpers';
const engines: Awaited<ReturnType<typeof database>>['engine'][] = [];
afterEach(async () => { await Promise.all(engines.splice(0).map(e => e.close())); });
async function fixture() { const f = await database(); engines.push(f.engine); return f; }
describe('ACCEPTANCE: composed immutable identity controls', () => {
  it('rejects a live SQL run under an unchanged test projection plan', async () => {
    const f = await fixture(), p = plan(); await save(f.store, p.checkpoints[0]!.key, runValue('live'));
    await expect(projector(p, f.store).project(scope)).rejects.toMatchObject({ code: 'invalid_snapshot' });
  });
  it('projects a matching SQL run through the production get-only reader', async () => {
    const f = await fixture(), p = plan(); await save(f.store, p.checkpoints[0]!.key, runValue('test'));
    const result = await projector(p, f.store).project(scope);
    expect(result.phases).toMatchObject([{ state: 'completed', outcomes: ['inconclusive'] }]);
    expect(result.snapshot.blockers).toHaveLength(1);
  });
  it('SQL acquisition scope remains tenant-bound when its caller object mutates during projection', async () => {
    const f = await fixture(), p = plan(); p.checkpoints = [];
    const trusted = { tenantId: 'tenant-A', jobId: scope.jobId };
    const acquisition = createPostgresEvaluationDataStore(f.db, trusted);
    const task = fixtureTask(); task.revision = 0; task.requestHash = digestA;
    task.spec.jobId = scope.jobId; task.state = 'waiting_for_data'; task.phase = 'discovery';
    await acquisition.insertIfAbsent(task);
    const foreign = createPostgresEvaluationDataStore(f.db, { ...trusted, tenantId: 'tenant-B' });
    const other = structuredClone(task); other.state = 'waiting_for_expert'; other.phase = 'expert';
    await foreign.insertIfAbsent(other);
    p.acquisitionTaskIds = [task.taskId];
    const result = await projector(p, f.store, acquisition, () => { trusted.tenantId = 'tenant-B'; trusted.jobId = 'other-job'; }).project(scope);
    expect(result.acquisition).toMatchObject([{ state: 'waiting_for_data', phase: 'discovery' }]);
    expect((await foreign.get(task.taskId))!.state).toBe('waiting_for_expert');
  });
  it('rejects key digest mutation during a SQL read even when the checkpoint adapter accepts it', async () => {
    const f = await fixture(), p = plan();
    await save(f.store, { ...p.checkpoints[0]!.key, inputDigest: digestB }, runValue('test'));
    const reader = { get: async (key: Parameters<typeof f.store.get>[0]) => {
      // The real reader copies the row identity before awaiting get.
      key.inputDigest = digestB;
      return f.store.get(key);
    } };
    await expect(projector(p, reader).project(scope)).rejects.toMatchObject({ code: 'invalid_snapshot' });
  });
});
