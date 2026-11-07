import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTransactionalSql } from '../../agents/postgres-ports';
import { PostgresTextCheckpointStore, type CheckpointKey } from './checkpoints';

const migration = readFileSync(new URL('./migrations/001-text-integration.sql', import.meta.url), 'utf8');
const key: CheckpointKey = { jobId: 'job', kind: 'target', id: 'run:S01', inputDigest: 'digest' };

describe('text checkpoint PostgreSQL adapter (real PGlite SQL; single connection)', () => {
  let engine: PGlite;
  let db: AgentTransactionalSql;
  let store: PostgresTextCheckpointStore;
  beforeEach(async () => {
    engine = new PGlite();
    await engine.exec(migration);
    db = {
      query: <T>(sql: string, params?: unknown[]) => engine.query<T>(sql, params),
      transaction: fn => engine.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })),
    };
    store = new PostgresTextCheckpointStore(db);
  });
  afterEach(async () => { await engine.close(); });

  it('atomically gives one claimant ownership and rejects changed inputs under the same identity', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.claim(key)));
    expect(results.filter(result => result.state === 'claimed')).toHaveLength(1);
    expect(results.filter(result => result.state === 'pending')).toHaveLength(7);
    await expect(store.claim({ ...key, inputDigest: 'different' })).rejects.toThrow('identity_conflict');
    await expect(store.get({ ...key, inputDigest: 'different' })).rejects.toThrow('identity_conflict');
    expect(await store.claim({ ...key, jobId: 'another-job' })).toMatchObject({ state: 'claimed' });
  });

  it('persists full detached output, resumes from a fresh adapter and rejects overwrite', async () => {
    const claimed = await store.claim(key);
    if (claimed.state !== 'claimed') throw new Error('expected owner');
    const value = { response: 'Exact 🧪\r\ntext', costs: [{ externalId: 'session-one', microUsd: 12 }] };
    await store.complete(key, claimed.token, value);
    value.response = 'mutated';
    const fresh = new PostgresTextCheckpointStore(db);
    expect(await fresh.claim(key)).toEqual({ state: 'completed', value: { response: 'Exact 🧪\r\ntext', costs: [{ externalId: 'session-one', microUsd: 12 }] } });
    const lookup = await fresh.get({ jobId: key.jobId, kind: key.kind, id: key.id });
    expect(lookup?.state).toBe('completed');
    await fresh.complete(key, claimed.token, { response: 'Exact 🧪\r\ntext', costs: [{ externalId: 'session-one', microUsd: 12 }] });
    await expect(fresh.complete(key, claimed.token, value)).rejects.toThrow('completion_conflict');
    await expect(fresh.complete(key, 'other-worker', value)).rejects.toThrow('not_owner');
  });

  it('never takes over a lost response, and ambiguity cannot be released or completed', async () => {
    const claimed = await store.claim(key);
    if (claimed.state !== 'claimed') throw new Error('expected owner');
    expect(await new PostgresTextCheckpointStore(db).claim(key)).toEqual({ state: 'pending' });
    await store.markAmbiguous(key, claimed.token);
    await store.markAmbiguous(key, claimed.token);
    expect(await new PostgresTextCheckpointStore(db).claim(key)).toEqual({ state: 'ambiguous' });
    await expect(store.release(key, claimed.token)).rejects.toThrow('not_releasable');
    await expect(store.complete(key, claimed.token, {})).rejects.toThrow('ambiguous');
  });

  it('allows explicit safe agent polling release while rejecting stale owners', async () => {
    const agentKey = { ...key, kind: 'design' };
    const claimed = await store.claim(agentKey);
    if (claimed.state !== 'claimed') throw new Error('expected owner');
    await expect(store.release(agentKey, 'wrong')).rejects.toThrow('not_releasable');
    await store.release(agentKey, claimed.token);
    await expect(store.claim({ ...agentKey, inputDigest: 'changed-after-release' })).rejects.toThrow('identity_conflict');
    await expect(store.complete(agentKey, claimed.token, {})).rejects.toThrow('not_owner');
    const next = await store.claim(agentKey);
    expect(next.state).toBe('claimed');
    await expect(store.complete(agentKey, claimed.token, {})).rejects.toThrow('not_owner');
    expect(await store.get(key)).toBeNull();
  });

  it('refuses lossy/non-PostgreSQL JSON before completion, preserving pending state', async () => {
    const claimed = await store.claim(key);
    if (claimed.state !== 'claimed') throw new Error('expected owner');
    for (const value of [{ hidden: undefined }, { number: Infinity }, { text: '\u0000' }, { text: '\ud800' }]) {
      await expect(store.complete(key, claimed.token, value)).rejects.toThrow('invalid_json');
    }
    expect(await store.get(key)).toEqual({ state: 'pending' });
    await store.complete(key, claimed.token, null);
    expect(await store.get(key)).toEqual({ state: 'completed', value: null });
  });
});
