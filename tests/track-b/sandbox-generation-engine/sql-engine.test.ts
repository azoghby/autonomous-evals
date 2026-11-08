import { expect, it } from 'vitest';
import { engineFixture } from './fixtures';
import { canonicalJson } from '../../../packages/core/src/evals/text/freeze';

it('actual durable engine resumes one adopted session after native SQL restart and replays exact authoritative gate artifact', async () => {
  const h = await engineFixture();
  try {
    const request = h.request('engine-restart');
    const pending = await h.make().engine.generate(request);
    expect(pending).toMatchObject({ status: 'pending', reason: 'session_running', artifact: null });
    expect(h.counts()).toEqual({ creates: 1, polls: 1, gates: 0, costs: 0, target: 0 });
    const reopened = await h.database.restart(); Object.assign(h.database, reopened);
    h.complete();
    const result = await h.make(h.database.ports[0], 'resumed').engine.generate(request);
    expect(result.status).toBe('complete');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].provenance.sessionId).toBe('engine_session_1');
    expect(result.artifact?.evidence[0].status).toBe('passed');
    expect(result.artifact?.evidence[0].runs).toHaveLength(4);
    expect(result.artifact?.evidence[0].mutations.length).toBeGreaterThan(0);
    const counts = h.counts();
    expect(counts.creates).toBe(1); expect(counts.polls).toBe(2); expect(counts.costs).toBe(1);
    expect(counts.gates).toBe(4); expect(counts.target).toBe(2);
    const replay = await h.make(h.database.ports[1], 'replay').engine.generate(request);
    expect(replay).toEqual(result);
    expect(canonicalJson(replay.artifact)).toBe(canonicalJson(result.artifact));
    expect(h.counts()).toEqual(counts);
    const rows = await h.database.observer.query('SELECT settled_micro_usd FROM agent_persistence.reservations WHERE settled_micro_usd IS NOT NULL');
    expect(rows.rows).toEqual([{ settled_micro_usd: '7' }]);
  } finally { await h.close(); }
}, 60_000);

it('legacy engine generation remains fenced and cannot be adopted by continuation', async () => {
  const h = await engineFixture();
  try {
    const { createDurableSandboxEngine } = await import('../../../packages/core/src/evals/sandbox/persistence/engine');
    const { config, persistenceConfig } = h.make();
    delete config.generationContinuation;
    const legacy = createDurableSandboxEngine(config, persistenceConfig);
    const request = h.request('actual-legacy');
    expect((await legacy.generate(request)).status).toBe('pending');
    const counts = h.counts();
    expect(counts.creates).toBe(1);
    expect((await h.make(h.database.ports[1], 'continuation').engine.generate(request)).status).toBe('blocked');
    expect((await legacy.generate(request)).status).toBe('blocked');
    expect(h.counts()).toEqual(counts);
  } finally { await h.close(); }
}, 60_000);

it('continuation admission prevents later dispatch through the actual legacy engine', async () => {
  const h = await engineFixture();
  try {
    const request = h.request('new-first');
    expect((await h.make().engine.generate(request)).status).toBe('pending');
    const { createDurableSandboxEngine } = await import('../../../packages/core/src/evals/sandbox/persistence/engine');
    const { config, persistenceConfig } = h.make(h.database.ports[1], 'legacy');
    delete config.generationContinuation;
    const counts = h.counts();
    expect((await createDurableSandboxEngine(config, persistenceConfig).generate(request)).status).toBe('blocked');
    expect(h.counts()).toEqual(counts);
  } finally { await h.close(); }
}, 60_000);
