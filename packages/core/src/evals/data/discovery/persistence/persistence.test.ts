import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTransactionalSql } from '../../../../agents/postgres-ports';
import { PostgresTextCheckpointStore, type TextCheckpointStore } from '../../../integration/checkpoints';
import type { DataBatch } from '../../acquisition';
import { createDiscoveryOperations, createPostgresDiscoveryOperations } from './index';

const migration = readFileSync(new URL('../../../integration/migrations/001-text-integration.sql', import.meta.url), 'utf8');
const digest = 'a'.repeat(64);
const otherDigest = 'b'.repeat(64);
const scope = { tenantId: 'tenant', jobId: 'job' };
const batch = (): DataBatch => ({ sources: [{
  id: 'mw_test', url: 'https://en.wikipedia.org/w/index.php?oldid=123', content: 'Public evidence 🧪',
  license: { name: 'Unknown', url: 'https://en.wikipedia.org', permission: 'unknown', allowedUses: [] },
  provenance: { origin: 'public', producerId: 'mediawiki:https://en.wikipedia.org', retrievedAt: '2026-01-01T00:00:00.000Z', contentHash: createHash('sha256').update('Public evidence 🧪').digest('hex') },
  review: { status: 'pending', reviewerId: '', reviewedAt: '', notes: 'Untrusted public retrieval.' },
}], cases: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('durable discovery operations (real PGlite SQL)', () => {
  let engine: PGlite;
  let db: AgentTransactionalSql;
  let store: PostgresTextCheckpointStore;
  const make = (authenticatedScope = scope) => createPostgresDiscoveryOperations({ db, authenticatedScope });
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

  it('grants exactly one owner across instances and concurrent calls, durably rejects input changes', async () => {
    const adapters = Array.from({ length: 8 }, () => make());
    const results = await Promise.all(adapters.map(adapter => adapter.claim('operation', digest)));
    expect(results.filter(result => result.state === 'claimed')).toHaveLength(1);
    expect(results.filter(result => result.state === 'pending')).toHaveLength(7);
    const owner = adapters[results.findIndex(result => result.state === 'claimed')]!;
    await expect(make().claim('operation', otherDigest)).rejects.toThrow('discovery_persistence_input_conflict');
    await expect(owner.complete('operation', otherDigest, batch())).rejects.toThrow('input_conflict');
    await expect(make().complete('operation', digest, batch())).rejects.toThrow('not_owner');
    await owner.complete('operation', digest, batch());
    await expect(make().claim('operation', otherDigest)).rejects.toThrow('input_conflict');
  });

  it('survives a late same-instance pending response without losing the winning token', async () => {
    const pending = deferred<void>();
    const arrived = deferred<void>();
    const wrapped: TextCheckpointStore = {
      claim: async key => {
        const result = await store.claim(key);
        if (result.state === 'pending') { arrived.resolve(); await pending.promise; }
        return result;
      },
      get: key => store.get(key), complete: (...args) => store.complete(...args),
      release: () => { throw new Error('must never release'); },
      markAmbiguous: (...args) => store.markAmbiguous(...args),
    };
    const adapter = createDiscoveryOperations({ store: wrapped, authenticatedScope: scope });
    const winner = adapter.claim('operation', digest);
    const loser = adapter.claim('operation', digest);
    expect(await winner).toEqual({ state: 'claimed' });
    await arrived.promise;
    pending.resolve();
    expect(await loser).toEqual({ state: 'pending' });
    await adapter.complete('operation', digest, batch());
    expect(await make().claim('operation', digest)).toEqual({ state: 'complete', data: batch() });
  });

  it('replays detached results from a new adapter and arbitrates completion races by SQL value', async () => {
    const adapter = make();
    await adapter.claim('operation', digest);
    const data = batch();
    const completing = adapter.complete('operation', digest, data);
    data.sources[0]!.review.notes = 'mutated after invocation';
    await completing;
    const replay = await make().claim('operation', digest);
    expect(replay).toEqual({ state: 'complete', data: batch() });
    if (replay.state === 'complete') replay.data.sources.length = 0;
    expect(await make().claim('operation', digest)).toEqual({ state: 'complete', data: batch() });
    await Promise.all([adapter.complete('operation', digest, batch()), adapter.complete('operation', digest, batch())]);
    await expect(adapter.complete('operation', digest, data)).rejects.toThrow('completion_conflict');
    const second = make();
    await second.claim('second', digest);
    const outcomes = await Promise.allSettled([second.complete('second', digest, batch()), second.complete('second', digest, { sources: [], cases: [] })]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1);
  });

  it('binds trusted tenant/job with collision-safe framing and snapshots scope', async () => {
    const mutable = { tenantId: 'one:two', jobId: 'three' };
    const first = make(mutable);
    mutable.tenantId = 'changed';
    await first.claim('operation', digest);
    await first.complete('operation', digest, batch());
    expect(await make({ tenantId: 'one:two', jobId: 'three' }).claim('operation', digest)).toMatchObject({ state: 'complete' });
    for (const authenticatedScope of [mutable, { tenantId: 'one', jobId: 'two:three' }, { tenantId: 'one:two', jobId: 'other' }]) {
      expect(await make(authenticatedScope).claim('operation', digest)).toEqual({ state: 'claimed' });
    }
    const rows = await engine.query<{ job_id: string; id: string }>('SELECT job_id, id FROM text_integration.checkpoints');
    expect(new Set(rows.rows.map(row => row.job_id)).size).toBe(4);
    expect(rows.rows.every(row => !row.job_id.includes('one:two') && /^[a-f0-9]{64}$/.test(row.id))).toBe(true);
  });

  it('never reclaims pending or ambiguous calls and enforces underlying token ownership', async () => {
    const adapter = make();
    await adapter.claim('operation', digest);
    expect(await make().claim('operation', digest)).toEqual({ state: 'pending' });
    await engine.exec("UPDATE text_integration.checkpoints SET state = 'ambiguous'");
    expect(await adapter.claim('operation', digest)).toEqual({ state: 'pending' });
    await expect(adapter.complete('operation', digest, batch())).rejects.toThrow('ambiguous');
    await engine.exec("UPDATE text_integration.checkpoints SET state = 'pending', token = 'different-owner'");
    await expect(adapter.complete('operation', digest, batch())).rejects.toThrow('not_owner');
  });

  it('keeps ownership for replay after a committed completion loses its acknowledgement', async () => {
    let loseAck = true;
    const wrapped: TextCheckpointStore = {
      claim: key => store.claim(key), get: key => store.get(key),
      complete: async (...args) => { await store.complete(...args); if (loseAck) { loseAck = false; throw new Error('password=private-sql-secret'); } },
      release: () => { throw new Error('must never release'); }, markAmbiguous: (...args) => store.markAmbiguous(...args),
    };
    const adapter = createDiscoveryOperations({ store: wrapped, authenticatedScope: scope });
    await adapter.claim('operation', digest);
    await expect(adapter.complete('operation', digest, batch())).rejects.toThrow(/^discovery_persistence_storage_unavailable$/);
    await adapter.complete('operation', digest, batch());
    expect(await make().claim('operation', digest)).toEqual({ state: 'complete', data: batch() });
  });

  it('rejects unsafe identities and malformed digests before SQL', async () => {
    for (const key of ['', ' ', 'a\u0000b', '\ud800', 'a\nb', 'x'.repeat(1025), 'person@example.com']) {
      await expect(make().claim(key, digest)).rejects.toThrow('invalid_identity');
    }
    for (const input of ['', 'sha256:abc', 'A'.repeat(64)]) await expect(make().claim('key', input)).rejects.toThrow('invalid_identity');
    expect(() => make({ tenantId: '', jobId: 'job' })).toThrow('invalid_identity');
    expect((await engine.query('SELECT * FROM text_integration.checkpoints')).rows).toHaveLength(0);
  });

  it('rejects malformed, secret, lossy and forged candidate results before persistence and on replay', async () => {
    const adapter = createPostgresDiscoveryOperations({ db, authenticatedScope: scope, knownSecrets: ['private-marker'] });
    await adapter.claim('operation', digest);
    const mutations: Array<(value: any) => void> = [
      value => { value.sources[0].content = 'tampered'; },
      value => { value.sources[0].review.status = 'approved'; },
      value => { value.sources[0].license.permission = 'allowed'; },
      value => { value.sources[0].url = 'https://user:password@example.org/'; },
      value => { value.sources[0].review.notes = 'private-marker'; },
      value => { value.sources[0].review.notes = '\u0000'; },
      value => { value.sources[0].review.notes = '\ud800'; },
      value => { value.sources[0].extra = undefined; },
      value => { value.sources[0].extra = Infinity; },
      value => { value.sources.push(value.sources[0]); },
      value => { value.cases.push({ id: 'forged' }); },
      value => { value.extra = value; },
      value => { value.sources[0].review = new Date(); },
      value => { Object.defineProperty(value, 'extra', { get() { throw new Error('raw-secret'); }, enumerable: true }); },
    ];
    for (const mutate of mutations) {
      const value = batch(); mutate(value);
      await expect(adapter.complete('operation', digest, value)).rejects.toThrow(/^discovery_persistence_invalid_result$/);
    }
    expect(await make().claim('operation', digest)).toEqual({ state: 'pending' });
    await adapter.complete('operation', digest, batch());
    await engine.exec(`UPDATE text_integration.checkpoints SET value = '{"sources":null,"cases":[]}'::jsonb`);
    await expect(make().claim('operation', digest)).rejects.toThrow(/^discovery_persistence_invalid_result$/);
  });
});
