import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSqlExecutor, AgentTransactionalSql } from '../agents/postgres-ports';
import { PostgresBudgetLedger } from '../agents/postgres-ports';
import { PostgresTextCheckpointStore } from '../evals/integration/checkpoints';
import { PostgresNaiveProxyDispatchStore } from './naive-proxy-dispatch-store';

const opened: PGlite[] = [];
afterEach(async () => { for (const pg of opened.splice(0)) await pg.close(); });

/** Real PostgreSQL SQL in PGlite; one connection serializes concurrent calls. */
async function fixture() {
  const pg = new PGlite(); opened.push(pg);
  await pg.exec(readFileSync(new URL('../agents/persistence-migrations/001-agent-persistence.sql', import.meta.url), 'utf8'));
  await pg.exec(readFileSync(new URL('../evals/integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
  await pg.exec(readFileSync(new URL('./migrations/001-proxy-dispatch.sql', import.meta.url), 'utf8'));
  let failBeforeCommit = false;
  let loseAcknowledgement = false;
  const db: AgentTransactionalSql = {
    query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params),
    transaction: async fn => {
      const value = await pg.transaction(async tx => {
        const result = await fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) });
        if (failBeforeCommit) { failBeforeCommit = false; throw new Error('injected rollback'); }
        return result;
      });
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('lost commit acknowledgement'); }
      return value;
    },
  };
  const config = { jobId: 'job-one', period: '2026-11', jobCapMicroUsd: 100, judgeCapMicroUsd: 100 };
  const make = () => new PostgresNaiveProxyDispatchStore(db, config);
  const input = { jobId: config.jobId, operationId: 'judge-one', inputDigest: 'a'.repeat(64), amountMicroUsd: 60 };
  const owner = vi.fn(async (_tx: AgentSqlExecutor, _identity: unknown) => ({ actorId: 'operator-one', reason: 'Confirmed unused dispatch' }));
  const ledger = new PostgresBudgetLedger(db);
  const committed = async () => (await pg.query<{ n: string }>("SELECT COALESCE(SUM(COALESCE(settled_micro_usd,amount_micro_usd)),0)::text AS n FROM agent_persistence.reservations WHERE first_result->>'ok'='true'")).rows[0].n;
  const settlement = async (id: string) => (await pg.query<{ n: string | null }>('SELECT settled_micro_usd::text AS n FROM agent_persistence.reservations WHERE id=$1', [id])).rows[0]?.n;
  return { pg, db, config, make, input, owner, ledger, committed, settlement,
    rollback: () => { failBeforeCommit = true; }, loseAck: () => { loseAcknowledgement = true; } };
}

describe('proxy dispatch attempts: migration-backed SQL and serialized interleavings', () => {
  it('replays preparation after restart without another hold and dispatches at most once', async () => {
    const f = await fixture();
    const first = await f.make().prepare(f.input);
    expect(first).toMatchObject({ state: 'prepared', attempt: 1 });
    expect(await f.make().isUndispatched(first)).toBe(true);
    expect(await f.make().prepare(f.input)).toEqual(first);
    expect(await f.committed()).toBe('60');
    await f.make().dispatch(first);
    expect(await f.make().isUndispatched(first)).toBe(false);
    expect(await f.make().prepare(f.input)).toMatchObject({ state: 'dispatched', attempt: 1 });
    await expect(f.make().dispatch(first)).rejects.toThrow();
    await expect(f.make().recoverUndispatched(first, f.owner)).rejects.toThrow();
    expect(await f.settlement(first.reservationId)).toBeNull();
  });

  it('requires explicit authorized recovery before retrying a denied attempt', async () => {
    const f = await fixture();
    const held = await f.make().prepare({ ...f.input, operationId: 'other' });
    const denied = await f.make().prepare(f.input);
    expect(denied).toMatchObject({ state: 'denied', attempt: 1 });
    expect(await f.make().isUndispatched(denied)).toBe(true);
    await f.ledger.settle(held.reservationId, 0);
    expect(await f.make().prepare(f.input)).toEqual(denied);
    await expect(f.make().dispatch(denied)).rejects.toThrow();
    await f.make().recoverUndispatched(denied, f.owner);
    expect(await f.make().isUndispatched(denied)).toBe(true);
    const fresh = await f.make().prepare(f.input);
    expect(fresh).toMatchObject({ state: 'prepared', attempt: 2 });
    expect(fresh.reservationId).not.toBe(denied.reservationId);
    expect(fresh.checkpointId).not.toBe(denied.checkpointId);
    expect(f.owner).toHaveBeenCalled();
    await expect(f.make().dispatch(denied)).rejects.toThrow();
  });

  it('releases a proven unused hold and never reuses its immutable zero settlement', async () => {
    const f = await fixture();
    const old = await f.make().prepare(f.input);
    await f.make().recoverUndispatched(old, f.owner);
    expect(await f.make().isUndispatched(old)).toBe(true);
    expect(await f.settlement(old.reservationId)).toBe('0');
    expect(await f.committed()).toBe('0');
    const fresh = await f.make().prepare(f.input);
    expect(fresh.attempt).toBe(2);
    expect(fresh.reservationId).not.toBe(old.reservationId);
    await f.make().dispatch(fresh);
    expect(await f.ledger.settle(fresh.reservationId, 17)).toMatchObject({ settledMicroUsd: 17, replayed: false });
    expect(await f.ledger.settle(old.reservationId, 17)).toMatchObject({ settledMicroUsd: 0, replayed: true });
    expect(await f.committed()).toBe('17');
    await expect(f.make().dispatch(old)).rejects.toThrow();
  });

  it('does not release or abandon an attempt when recovery authorization is revoked', async () => {
    const f = await fixture();
    const first = await f.make().prepare(f.input);
    const revoked = vi.fn(async () => { throw new Error('authority revoked'); });
    await expect(f.make().recoverUndispatched(first, revoked)).rejects.toThrow('authority revoked');
    expect(revoked).toHaveBeenCalled();
    expect(await f.make().prepare(f.input)).toEqual(first);
    expect(await f.settlement(first.reservationId)).toBeNull();
    expect(await f.committed()).toBe('60');
  });

  it('recovers lost preparation acknowledgement without another attempt or hold', async () => {
    const f = await fixture();
    f.loseAck();
    await expect(f.make().prepare(f.input)).rejects.toThrow('lost commit acknowledgement');
    const retained = await f.make().prepare(f.input);
    expect(retained).toMatchObject({ state: 'prepared', attempt: 1 });
    expect(await f.committed()).toBe('60');
    expect(await f.make().prepare(f.input)).toEqual(retained);
  });

  it('retains the dispatch fence after its acknowledgement is lost', async () => {
    const f = await fixture();
    const retained = await f.make().prepare(f.input);
    f.loseAck();
    await expect(f.make().dispatch(retained)).rejects.toThrow('lost commit acknowledgement');
    await expect(f.make().dispatch(retained)).rejects.toThrow();
    await expect(f.make().recoverUndispatched(retained, f.owner)).rejects.toThrow();
    expect(await f.make().prepare(f.input)).toMatchObject({ state: 'dispatched', attempt: 1 });
    expect(await f.settlement(retained.reservationId)).toBeNull();
  });

  it('replays lost recovery acknowledgement without recovering the replacement attempt', async () => {
    const f = await fixture();
    const old = await f.make().prepare(f.input);
    f.loseAck();
    await expect(f.make().recoverUndispatched(old, f.owner)).rejects.toThrow('lost commit acknowledgement');
    expect(await f.settlement(old.reservationId)).toBe('0');
    const replacement = await f.make().prepare(f.input);
    expect(replacement.attempt).toBe(2);
    expect(await f.make().recoverUndispatched(old, f.owner)).toMatchObject({ attempt: 1, replayed: true });
    expect(await f.make().prepare(f.input)).toEqual(replacement);
    expect(await f.settlement(replacement.reservationId)).toBeNull();
    expect(await f.committed()).toBe('60');
  });

  it('rolls back preparation and recovery SQL atomically on callback failure', async () => {
    const f = await fixture();
    f.rollback();
    await expect(f.make().prepare(f.input)).rejects.toThrow('injected rollback');
    expect(await f.committed()).toBe('0');
    const first = await f.make().prepare(f.input);
    expect(first.attempt).toBe(1);
    f.rollback();
    await expect(f.make().recoverUndispatched(first, f.owner)).rejects.toThrow('injected rollback');
    expect(await f.make().prepare(f.input)).toEqual(first);
    expect(await f.settlement(first.reservationId)).toBeNull();
    await f.make().dispatch(first);
  });

  it('serializes same-operation preparations and fences stale workers after recovery', async () => {
    const f = await fixture();
    const attempts = await Promise.all(Array.from({ length: 6 }, () => f.make().prepare(f.input)));
    expect(new Set(attempts.map(a => a.reservationId)).size).toBe(1);
    expect(new Set(attempts.map(a => a.token)).size).toBe(1);
    const stale = attempts[0];
    const results = await Promise.all(Array.from({ length: 4 }, () => f.make().recoverUndispatched(stale, f.owner)));
    expect(results.filter(r => !r.replayed)).toHaveLength(1);
    expect(await f.committed()).toBe('0');
    const fresh = await f.make().prepare(f.input);
    await expect(f.make().dispatch(stale)).rejects.toThrow();
    await f.make().dispatch(fresh);
    await expect(f.make().recoverUndispatched(fresh, f.owner)).rejects.toThrow();
  });

  it('rejects altered immutable operation identity, worker token and recovery identity', async () => {
    const f = await fixture();
    const first = await f.make().prepare(f.input);
    await expect(f.make().prepare({ ...f.input, inputDigest: 'b'.repeat(64) })).rejects.toThrow();
    await expect(f.make().prepare({ ...f.input, amountMicroUsd: 61 })).rejects.toThrow();
    await expect(f.make().dispatch({ ...first, token: 'forged' })).rejects.toThrow();
    await expect(f.make().dispatch({ ...first, reservationId: 'invented' })).rejects.toThrow();
    await expect(f.make().recoverUndispatched({ ...first, inputDigest: 'b'.repeat(64) }, f.owner)).rejects.toThrow();
    expect(await f.make().prepare(f.input)).toEqual(first);
    expect(await f.committed()).toBe('60');
  });

  it('validates live SQL authority inside recovery and preserves the recovery audit', async () => {
    const f = await fixture();
    await f.pg.exec('CREATE TABLE fixture_authority (allowed boolean NOT NULL); INSERT INTO fixture_authority VALUES (false)');
    const first = await f.make().prepare(f.input);
    const liveOwner = vi.fn(async (tx: AgentSqlExecutor) => {
      const authority = (await tx.query<{ allowed: boolean }>('SELECT allowed FROM fixture_authority')).rows[0];
      if (!authority?.allowed) throw new Error('current SQL authority revoked');
      return { actorId: 'operator-two', reason: 'Unused attempt reviewed' };
    });
    await expect(f.make().recoverUndispatched(first, liveOwner)).rejects.toThrow('current SQL authority revoked');
    await f.pg.exec('UPDATE fixture_authority SET allowed=true');
    await f.make().recoverUndispatched(first, liveOwner);
    expect((await f.pg.query('SELECT actor_id,reason FROM naive_proxy_dispatch.recoveries')).rows).toEqual([
      { actor_id: 'operator-two', reason: 'Unused attempt reviewed' },
    ]);
    await f.pg.exec('UPDATE fixture_authority SET allowed=false');
    await expect(f.make().recoverUndispatched(first, liveOwner)).rejects.toThrow('current SQL authority revoked');
    expect((await f.pg.query('SELECT actor_id FROM naive_proxy_dispatch.recoveries')).rows).toHaveLength(1);
  });

  it('refuses legacy checkpoint or reservation identities instead of adopting them as new attempts', async () => {
    const f = await fixture();
    const { proxyBillingDigest } = await import('./naive-proxy-reconcile');
    const legacy = proxyBillingDigest({ jobId: f.input.jobId, operationId: f.input.operationId });
    expect((await new PostgresTextCheckpointStore(f.db).claim({ jobId: f.input.jobId, kind: 'naive_proxy_judge', id: legacy, inputDigest: f.input.inputDigest })).state).toBe('claimed');
    await expect(f.make().prepare(f.input)).rejects.toThrow();
    await f.pg.exec('DELETE FROM text_integration.checkpoints');
    await f.ledger.reserve({ reservationId: `naive-proxy:${legacy}`, jobId: f.input.jobId, amountMicroUsd: 60, scopes: [
      { key: `job:${f.input.jobId}`, capMicroUsd: 100 }, { key: 'agent:judge:2026-11', capMicroUsd: 100 },
    ] });
    await expect(f.make().prepare(f.input)).rejects.toThrow();
    expect((await f.pg.query('SELECT * FROM naive_proxy_dispatch.operations')).rows).toHaveLength(0);
  });

  it('rolls back a failed dispatch fence before allowing the retained worker to dispatch', async () => {
    const f = await fixture();
    const first = await f.make().prepare(f.input);
    f.rollback();
    await expect(f.make().dispatch(first)).rejects.toThrow('injected rollback');
    expect(await f.make().prepare(f.input)).toEqual(first);
    await f.make().dispatch(first);
    await expect(f.make().dispatch(first)).rejects.toThrow();
  });

  it.each(['dispatch', 'recover'] as const)('serializes a %s-first race without releasing a dispatched hold', async firstAction => {
    const f = await fixture();
    const retained = await f.make().prepare(f.input);
    const dispatch = () => f.make().dispatch(retained);
    const recover = () => f.make().recoverUndispatched(retained, f.owner);
    const results = await Promise.allSettled(firstAction === 'dispatch' ? [dispatch(), recover()] : [recover(), dispatch()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const next = await f.make().prepare(f.input);
    if (next.state === 'dispatched') {
      expect(next.attempt).toBe(1);
      expect(await f.settlement(retained.reservationId)).toBeNull();
    } else {
      expect(next).toMatchObject({ state: 'prepared', attempt: 2 });
      expect(await f.settlement(retained.reservationId)).toBe('0');
    }
    expect(await f.committed()).toBe('60');
  });

  it('atomically reserves the generic allocation scope, clones its config and rejects changed policy', async () => {
    const f = await fixture();
    const allocation = { key: 'generic-text:job-one:allocation', capMicroUsd: 60 };
    const supplied = { ...f.config, additionalScopes: [allocation] };
    const store = new PostgresNaiveProxyDispatchStore(f.db, supplied);
    allocation.capMicroUsd = 999;
    supplied.additionalScopes.push({ key: 'untrusted-later-scope', capMicroUsd: 999 });
    const first = await store.prepare(f.input);
    expect(first.state).toBe('prepared');
    const saved = (await f.pg.query<{ scopes: { key: string; capMicroUsd: number }[] }>(
      'SELECT scopes FROM agent_persistence.reservations WHERE id=$1', [first.reservationId],
    )).rows[0];
    expect(saved.scopes).toEqual([
      { key: 'agent:judge:2026-11', capMicroUsd: 100 },
      { key: 'generic-text:job-one:allocation', capMicroUsd: 60 },
      { key: 'job:job-one', capMicroUsd: 100 },
    ]);
    const denied = await store.prepare({ ...f.input, operationId: 'second', amountMicroUsd: 50 });
    expect(denied.state).toBe('denied');
    expect(await f.committed()).toBe('60');
    const changed = new PostgresNaiveProxyDispatchStore(f.db, {
      ...f.config, additionalScopes: [{ key: 'generic-text:job-one:allocation', capMicroUsd: 61 }],
    });
    await expect(changed.prepare(f.input)).rejects.toThrow();
    expect(await store.prepare(f.input)).toEqual(first);
    await store.dispatch(first);
    await f.ledger.settle(first.reservationId, 20);
    const allocationDenied = await store.prepare({ ...f.input, operationId: 'third', amountMicroUsd: 50 });
    expect(allocationDenied.state).toBe('denied');
    const result = (await f.pg.query<{ first_result: unknown }>(
      'SELECT first_result FROM agent_persistence.reservations WHERE id=$1', [allocationDenied.reservationId],
    )).rows[0].first_result;
    expect(result).toMatchObject({ ok: false, exhaustedScope: 'generic-text:job-one:allocation', availableMicroUsd: 40 });
    expect(await f.committed()).toBe('20');
  });

  it.each(['naive_proxy_judge', 'naive_proxy_intent', 'naive_proxy_received'])('fences a restarted legacy %s writer after preparation', async kind => {
    const f = await fixture();
    const { proxyBillingDigest } = await import('./naive-proxy-reconcile');
    const legacy = proxyBillingDigest({ jobId: f.input.jobId, operationId: f.input.operationId });
    f.loseAck();
    await expect(f.make().prepare(f.input)).rejects.toThrow('lost commit acknowledgement');
    const retained = await f.make().prepare(f.input);
    const oldCheckpoints = new PostgresTextCheckpointStore(f.db);
    await expect(oldCheckpoints.claim({ jobId: f.input.jobId, kind, id: legacy, inputDigest: f.input.inputDigest })).rejects.toThrow('legacy_identity_fenced');
    expect(await f.make().prepare(f.input)).toEqual(retained);
    expect(await f.committed()).toBe('60');
    expect((await f.pg.query('SELECT * FROM text_integration.checkpoints')).rows).toHaveLength(0);
  });

  it('preserves unrelated checkpoints and reapplies its sidecar without losing attempts or fencing', async () => {
    const f = await fixture();
    const { proxyBillingDigest } = await import('./naive-proxy-reconcile');
    const legacy = proxyBillingDigest({ jobId: f.input.jobId, operationId: f.input.operationId });
    const retained = await f.make().prepare(f.input);
    const checkpoints = new PostgresTextCheckpointStore(f.db);
    const unrelated = { jobId: f.input.jobId, kind: 'scenario_execution', id: legacy, inputDigest: f.input.inputDigest };
    const claim = await checkpoints.claim(unrelated);
    expect(claim.state).toBe('claimed');
    if (claim.state !== 'claimed') throw new Error('expected owned fixture checkpoint');
    await checkpoints.complete(unrelated, claim.token, { execution: 'retained' });
    await f.pg.exec(readFileSync(new URL('./migrations/001-proxy-dispatch.sql', import.meta.url), 'utf8'));
    expect(await f.make().prepare(f.input)).toEqual(retained);
    expect(await checkpoints.get(unrelated)).toEqual({ state: 'completed', value: { execution: 'retained' } });
    await expect(checkpoints.claim({ ...unrelated, kind: 'naive_proxy_judge' })).rejects.toThrow('legacy_identity_fenced');
    const otherProxy = await checkpoints.claim({ ...unrelated, kind: 'naive_proxy_judge', id: 'another-operation-id' });
    expect(otherProxy.state).toBe('claimed');
    expect(await f.committed()).toBe('60');
  });

  it('prevents direct SQL changes to operation policy, identity or attempt sequence', async () => {
    const f = await fixture();
    const first = await f.make().prepare(f.input);
    for (const [column, value] of [
      ['input_digest', 'b'.repeat(64)], ['legacy_checkpoint_id', 'replacement'], ['operation_id', 'replacement'],
    ] as const) {
      await expect(f.pg.query(`UPDATE naive_proxy_dispatch.operations SET ${column}=$1`, [value])).rejects.toThrow('identity_immutable');
    }
    await expect(f.pg.query("UPDATE naive_proxy_dispatch.operations SET policy='{}'::jsonb")).rejects.toThrow('identity_immutable');
    await expect(f.pg.query('UPDATE naive_proxy_dispatch.operations SET active_attempt=2')).rejects.toThrow('invalid_attempt_transition');
    await f.make().recoverUndispatched(first, f.owner);
    await expect(f.pg.query('UPDATE naive_proxy_dispatch.operations SET active_attempt=3')).rejects.toThrow('invalid_attempt_transition');
    const next = await f.make().prepare(f.input);
    expect(next.attempt).toBe(2);
    await expect(f.pg.query('UPDATE naive_proxy_dispatch.operations SET active_attempt=1')).rejects.toThrow('invalid_attempt_transition');
    await expect(f.pg.query('DELETE FROM naive_proxy_dispatch.operations')).rejects.toThrow('history_immutable');
    expect(await f.make().prepare(f.input)).toEqual(next);
  });

  it('prevents direct SQL reopening of terminal attempts or changes to their identity', async () => {
    const f = await fixture();
    const dispatched = await f.make().prepare(f.input);
    await f.make().dispatch(dispatched);
    for (const state of ['prepared', 'denied', 'abandoned']) {
      await expect(f.pg.query('UPDATE naive_proxy_dispatch.attempts SET state=$1 WHERE reservation_id=$2', [state, dispatched.reservationId])).rejects.toThrow('invalid_state_transition');
    }
    for (const [column, value] of [
      ['token', 'replacement'], ['reservation_id', 'replacement'], ['checkpoint_id', 'replacement'],
    ] as const) {
      await expect(f.pg.query(`UPDATE naive_proxy_dispatch.attempts SET ${column}=$1 WHERE reservation_id=$2`, [value, dispatched.reservationId])).rejects.toThrow('identity_immutable');
    }
    await expect(f.pg.query('UPDATE naive_proxy_dispatch.attempts SET reserved=false WHERE reservation_id=$1', [dispatched.reservationId])).rejects.toThrow('identity_immutable');
    await expect(f.pg.query('DELETE FROM naive_proxy_dispatch.attempts WHERE reservation_id=$1', [dispatched.reservationId])).rejects.toThrow('history_immutable');
    const unused = await f.make().prepare({ ...f.input, operationId: 'unused', amountMicroUsd: 20 });
    await f.make().recoverUndispatched(unused, f.owner);
    await expect(f.pg.query("UPDATE naive_proxy_dispatch.attempts SET state='prepared' WHERE reservation_id=$1", [unused.reservationId])).rejects.toThrow('invalid_state_transition');
    expect(await f.make().prepare(f.input)).toMatchObject({ state: 'dispatched', attempt: 1 });
    expect(await f.settlement(dispatched.reservationId)).toBeNull();
  });

  it('preserves immutable recovery audits across migration reapplication', async () => {
    const f = await fixture();
    const first = await f.make().prepare(f.input);
    await f.make().recoverUndispatched(first, f.owner);
    const audit = (await f.pg.query('SELECT * FROM naive_proxy_dispatch.recoveries')).rows;
    await f.pg.exec(readFileSync(new URL('./migrations/001-proxy-dispatch.sql', import.meta.url), 'utf8'));
    await expect(f.pg.query("UPDATE naive_proxy_dispatch.recoveries SET reason='rewritten'")).rejects.toThrow('recovery_audit_immutable');
    await expect(f.pg.query('DELETE FROM naive_proxy_dispatch.recoveries')).rejects.toThrow('recovery_audit_immutable');
    await expect(f.pg.query('DELETE FROM naive_proxy_dispatch.attempts')).rejects.toThrow('history_immutable');
    expect((await f.pg.query('SELECT * FROM naive_proxy_dispatch.recoveries')).rows).toEqual(audit);
    expect(await f.make().prepare(f.input)).toMatchObject({ state: 'prepared', attempt: 2 });
  });

  it('retains exact historical proof of non-dispatch after a replacement dispatches', async () => {
    const f = await fixture();
    const old = await f.make().prepare(f.input);
    await f.make().recoverUndispatched(old, f.owner);
    const replacement = await f.make().prepare(f.input);
    await f.make().dispatch(replacement);
    expect(await f.make().isUndispatched(old)).toBe(true);
    expect(await f.make().isUndispatched(replacement)).toBe(false);
    await expect(f.make().dispatch(old)).rejects.toThrow();
    expect(await f.make().isUndispatched({ ...old, token: 'forged' })).toBe(false);
    expect(await f.make().isUndispatched({ ...old, inputDigest: 'b'.repeat(64) })).toBe(false);
    expect(await f.make().isUndispatched({ ...old, checkpointId: 'forged' })).toBe(false);
    expect(await f.make().isUndispatched({ ...old, reservationId: 'forged' })).toBe(false);
    expect(await f.settlement(old.reservationId)).toBe('0');
    expect(await f.settlement(replacement.reservationId)).toBeNull();
    expect(await f.make().prepare(f.input)).toMatchObject({ state: 'dispatched', attempt: 2 });
  });
});
