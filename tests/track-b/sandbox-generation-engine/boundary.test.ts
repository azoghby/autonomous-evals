import { describe, expect, it } from 'vitest';
import { createDurableSandboxEngine, createPostgresSandboxPersistence } from '../../../packages/core/src/evals/sandbox/persistence';
import { createPostgresSandboxGenerationContinuation } from '../../../packages/core/src/evals/sandbox/generation/continuation';
import { executionDigest } from '../../../packages/core/src/evals/sandbox/execution/runner';
import { engineFixture } from './fixtures';

describe('actual engine generation admission and current authority boundaries', () => {
  for (const state of ['pending', 'ambiguous', 'completed'] as const) {
    it(`refuses an existing legacy ${state} durable claim without dispatch or takeover`, async () => {
      const f = await engineFixture();
      try {
        const input = f.request(`legacy-${state}`);
        const { engine, persistenceConfig } = f.make();
        const legacy = createPostgresSandboxPersistence(persistenceConfig);
        // The actual legacy adapter prefixes the public request key with jobId.
        const legacyOperationKey = `${persistenceConfig.scope.jobId}:${input.operationKey}`;
        expect(await legacy.bindOperation(legacyOperationKey, 'legacy-request-digest')).toBe('bound');
        // A legacy completed/ambiguous row is still evidence that work might have
        // dispatched. Neither outcome grants authority to adopt a new namespace.
        await f.database.observer.query(
          "UPDATE text_integration.checkpoints SET state = $1, value = CASE WHEN $1 = 'completed' THEN '{}'::jsonb ELSE NULL END WHERE job_id = $2 AND kind = $3 AND id = $4",
          [state, `sandbox-persistence-v1:${executionDigest(persistenceConfig.scope)}`, 'sandbox_generation_binding_v1', executionDigest(legacyOperationKey)],
        );
        const before = f.counts();
        const result = await engine.generate(input);
        expect(result).toMatchObject({ status: 'blocked', artifact: null, candidates: [] });
        expect(f.counts()).toEqual(before);
        const row = await f.database.observer.query(
          'SELECT state, input_digest FROM text_integration.checkpoints WHERE job_id = $1 AND kind = $2 AND id = $3',
          [`sandbox-persistence-v1:${executionDigest(persistenceConfig.scope)}`, 'sandbox_generation_binding_v1', executionDigest(legacyOperationKey)],
        );
        expect(row.rows).toEqual([{ state, input_digest: 'legacy-request-digest' }]);
      } finally { await f.close(); }
    }, 60_000);
  }

  it('preserves the existing legacy engine route and refuses later continuation adoption', async () => {
    const f = await engineFixture();
    try {
      f.complete();
      const input = f.request('actual-legacy-engine');
      const { config, persistenceConfig } = f.make();
      delete config.generationContinuation;
      const legacy = createDurableSandboxEngine(config, persistenceConfig);
      const completed = await legacy.generate(input);
      expect(completed.status).toBe('complete');
      expect(completed.artifact).not.toBeNull();
      const before = f.counts();
      expect(await legacy.generate(input)).toMatchObject({ status: 'blocked', artifact: null });
      expect(await f.make(f.database.ports[1], 'continuation-adoption').engine.generate(input))
        .toMatchObject({ status: 'blocked', artifact: null, candidates: [] });
      expect(f.counts()).toEqual(before);
    } finally { await f.close(); }
  }, 60_000);

  it('atomically excludes a racing legacy binder under the actual adapter operation key', async () => {
    const f = await engineFixture();
    try {
      f.complete();
      const input = f.request('racing-legacy');
      const { engine, persistenceConfig } = f.make();
      const legacy = createPostgresSandboxPersistence({ ...persistenceConfig, db: f.database.ports[1] });
      const [generated, legacyResult] = await Promise.all([
        engine.generate(input),
        legacy.bindOperation(`${persistenceConfig.scope.jobId}:${input.operationKey}`, 'legacy-racing-digest'),
      ]);
      if (legacyResult === 'bound') {
        expect(generated).toMatchObject({ status: 'blocked', artifact: null, candidates: [] });
        expect(f.counts()).toMatchObject({ creates: 0, gates: 0, costs: 0, target: 0 });
      } else {
        expect(legacyResult).toBe('conflict');
        expect(generated.status).toBe('complete');
        expect(generated.artifact).not.toBeNull();
        expect(f.counts().creates).toBe(1);
      }
    } finally { await f.close(); }
  }, 60_000);

  it('rejects changed execution identity without replacement sessions, costs or gate effects', async () => {
    const f = await engineFixture();
    try {
      f.complete();
      const input = f.request('identity-change');
      expect((await f.make().engine.generate(input)).status).toBe('complete');
      const before = f.counts();
      const changed = await f.make(f.database.ports[1], 'changed-worker', 'fixture-engine-v2').engine.generate(input);
      expect(changed).toMatchObject({ status: 'blocked', artifact: null, candidates: [] });
      expect(f.counts()).toEqual(before);
    } finally { await f.close(); }
  }, 60_000);

  it('reauthorizes completed replay before returning private artifact evidence', async () => {
    const f = await engineFixture();
    try {
      f.complete();
      const input = f.request('revoked');
      expect((await f.make().engine.generate(input)).artifact).not.toBeNull();
      const before = f.counts();
      f.revoke();
      await expect(f.make(f.database.ports[1], 'revoked-worker').engine.generate(input)).rejects.toThrow('unauthorized');
      expect(f.counts()).toEqual(before);
    } finally { await f.close(); }
  }, 60_000);

  it('rejects tenant mismatch at the continuation constructor before any SQL or provider work', async () => {
    const f = await engineFixture();
    try {
      const { config, persistenceConfig } = f.make();
      const before = f.counts();
      expect(() => createPostgresSandboxGenerationContinuation({
        ...config.generation,
        assessCandidate: async () => ({ status: 'passed' as const }),
        service: config.generation.runner as Parameters<typeof createPostgresSandboxGenerationContinuation>[0]['service'],
        db: persistenceConfig.db,
        scope: { ...persistenceConfig.scope, tenantId: 'foreign-tenant' },
        executionIdentity: 'fixture-engine-v1',
        authorize: async () => true,
      })).toThrow('invalid_sandbox_continuation_config');
      expect(f.counts()).toEqual(before);
    } finally { await f.close(); }
  }, 60_000);

  it('pins mutable construction scope and job while still consulting the current authority closure', async () => {
    const f = await engineFixture();
    try {
      f.complete();
      const input = f.request('mutable-construction');
      const { engine, config, persistenceConfig } = f.make();
      const expected = await engine.generate(input);
      expect(expected.artifact).not.toBeNull();
      config.scope.jobId = 'foreign-job';
      config.scope.environmentId = 'foreign-environment';
      config.generation.job.customerId = 'foreign-tenant';
      config.generation.job.jobId = 'foreign-job';
      persistenceConfig.scope.jobId = 'foreign-job';
      persistenceConfig.scope.tenantId = 'foreign-tenant';
      const before = f.counts();
      expect(await engine.generate(input)).toEqual(expected);
      expect(f.counts()).toEqual(before);
      f.revoke();
      await expect(engine.generate(input)).rejects.toThrow('unauthorized');
      expect(f.counts()).toEqual(before);
    } finally { await f.close(); }
  }, 60_000);
});
