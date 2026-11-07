import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSqlExecutor, AgentTransactionalSql } from '../../agents/postgres-ports.js';
import { createPostgresConversationPort } from './postgres-conversations.js';
import { createProgressChatService } from './service.js';
import type { ChatAppendInput, ConversationPort } from './types.js';

const migration = readFileSync(new URL('./persistence-migrations/001-conversations.sql', import.meta.url), 'utf8');
const scope = { subjectId: 'alice', jobId: 'job-1' };
const storageError = { code: 'storage_error', message: 'Conversation storage is unavailable or invalid.' };
const row = (messageId = 'msg-1'): ChatAppendInput => ({
  messageId, inputDigest: createHash('sha256').update(messageId).digest('hex'),
  reply: { asOf: '2026-11-07T00:00:00Z', topic: 'progress', text: 'Persisted state: running. 🧪', evidenceRefs: ['state-1'], unknowns: ['ETA unknown.'] },
});
const connectEngine = (engine: PGlite): AgentTransactionalSql => ({
  query: <T>(sql: string, params?: unknown[]) => engine.query<T>(sql, params),
  transaction: fn => engine.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })),
});

describe('PostgreSQL conversations: real PGlite SQL, single session', () => {
  let engine: PGlite;
  let db: AgentTransactionalSql;
  let port: ConversationPort;
  beforeEach(async () => {
    engine = new PGlite();
    await engine.exec(migration);
    db = connectEngine(engine); port = createPostgresConversationPort(db);
  });
  afterEach(async () => { await engine.close(); });

  it('partitions every operation by both subject and job, with independent sequences', async () => {
    expect(await port.get(scope, 'msg-1')).toBeNull();
    const saved = await port.append(scope, row());
    expect(saved.sequence).toBe(1);
    for (const other of [{ ...scope, subjectId: 'bob' }, { ...scope, jobId: 'job-2' }]) {
      expect(await port.get(other, 'msg-1')).toBeNull();
      expect(await port.list(other, { afterSequence: 0, limit: 50 })).toEqual([]);
      const different = await port.append(other, { ...row(), inputDigest: 'b'.repeat(64) });
      expect(different.sequence).toBe(1);
      expect(await port.get(scope, 'msg-1')).toEqual(saved);
    }
  });

  it('keeps the first digest, reply, freshness and sequence across adapter recreation', async () => {
    const input = row();
    const saved = await port.append(scope, input);
    input.reply.text = 'caller mutation'; saved.reply.text = 'result mutation';
    const restarted = createPostgresConversationPort(db);
    const original = await restarted.get(scope, 'msg-1');
    expect(original?.reply.text).toBe(row().reply.text);
    expect(await restarted.append(scope, { ...row(), inputDigest: 'f'.repeat(64), reply: { ...row().reply, text: 'changed reply', asOf: '2026-11-08T00:00:00Z' } })).toEqual(original);
    expect((await port.append(scope, row('next'))).sequence).toBe(2);
    expect(await restarted.list(scope, { afterSequence: 0, limit: 50 })).toHaveLength(2);
  });

  it('integrates with the service and replays without reading current progress', async () => {
    let reads = 0;
    const access = {
      async authenticate() { return { subjectId: scope.subjectId }; },
      async resolveAuthorizedJob() { return scope; },
    };
    const service = createProgressChatService({ access, conversations: port, progress: { async read() {
      reads++;
      return { jobId: scope.jobId, observedAt: '2026-11-07T00:00:00Z', status: 'running', statusEvidenceRef: 'status-1',
        milestones: [], findings: [], blockers: [], costs: [], unknownCosts: true };
    } } });
    const request = { jobId: scope.jobId, messageId: 'service-message', question: 'What is the progress?' };
    const first = await service.send(request);
    expect(reads).toBe(1);
    const restarted = createProgressChatService({ access, conversations: createPostgresConversationPort(db),
      progress: { async read() { throw new Error('Current projection unavailable'); } } });
    expect(await restarted.send(request)).toEqual(first);
    await expect(restarted.send({ ...request, question: 'What is the cost?' })).rejects.toMatchObject({ code: 'conflict' });
    expect(reads).toBe(1);
  });

  it('rejects cross-scope, wrong-ID, unsafe bigint and malformed rows returned by a driver', async () => {
    const saved = await port.append(scope, row());
    const persisted = { subject_id: scope.subjectId, job_id: scope.jobId, message_id: saved.messageId,
      input_digest: saved.inputDigest, reply: saved.reply, sequence: String(saved.sequence) };
    for (const patch of [{ subject_id: 'bob' }, { job_id: 'job-2' }, { message_id: 'wrong-id' },
      { sequence: '9007199254740992' }, { sequence: '1.0' }, { sequence: 0 }, { input_digest: 'secret' }]) {
      const malformed: AgentTransactionalSql = {
        async query<T>() { return { rows: [{ ...persisted, ...patch }] as T[] }; }, transaction: db.transaction,
      };
      await expect(createPostgresConversationPort(malformed).get(scope, saved.messageId)).rejects.toMatchObject(storageError);
    }
    for (const rows of [[persisted, persisted], [{ ...persisted, subject_id: 'bob' }]]) {
      const malformed: AgentTransactionalSql = { async query<T>() { return { rows: rows as T[] }; }, transaction: db.transaction };
      await expect(createPostgresConversationPort(malformed).list(scope, { afterSequence: 0, limit: 50 })).rejects.toMatchObject(storageError);
    }
  });

  it('paginates an exclusive ascending cursor with bounded pages', async () => {
    for (let i = 0; i < 53; i++) await port.append(scope, row(`m-${i}`));
    const first = await port.list(scope, { afterSequence: 0, limit: 50 });
    const last = await port.list(scope, { afterSequence: first[49]!.sequence, limit: 50 });
    expect(first).toHaveLength(50); expect(last).toHaveLength(3);
    expect([...first, ...last].map(item => item.sequence)).toEqual(Array.from({ length: 53 }, (_, i) => i + 1));
    expect(await port.list(scope, { afterSequence: 53, limit: 1 })).toEqual([]);
    for (const query of [{ afterSequence: -1, limit: 1 }, { afterSequence: 0, limit: 0 }, { afterSequence: 0, limit: 51 }, { afterSequence: 1.5, limit: 1 }, { afterSequence: Number.MAX_SAFE_INTEGER + 1, limit: 1 }]) {
      await expect(port.list(scope, query)).rejects.toMatchObject(storageError);
    }
  });

  it('serializes concurrent PGlite transaction callbacks and preserves first-write replay', async () => {
    const other = createPostgresConversationPort(db);
    const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? port : other).append(scope, {
      ...row(), inputDigest: String(i % 10).repeat(64), reply: { ...row().reply, text: `candidate-${i}` },
    })));
    expect(replies.every(value => JSON.stringify(value) === JSON.stringify(replies[0]))).toBe(true);
    const distinct = await Promise.all(Array.from({ length: 12 }, (_, i) => other.append(scope, row(`distinct-${i}`))));
    expect(distinct.map(value => value.sequence).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 2));
    expect(await port.list(scope, { afterSequence: 0, limit: 50 })).toHaveLength(13);
  });

  it('uses bound parameters for SQL-looking subjects and never queries outside both scope keys', async () => {
    const hostile = { ...scope, subjectId: "alice'; DROP TABLE reporting_chat_exchanges; --" };
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    const observe = (executor: AgentSqlExecutor): AgentSqlExecutor => ({ async query<T>(sql: string, params?: unknown[]) {
      seen.push({ sql, params }); return executor.query<T>(sql, params);
    } });
    const observed = createPostgresConversationPort({ ...observe(db), transaction: fn => db.transaction(tx => fn(observe(tx))) });
    await observed.append(hostile, row());
    await observed.get(hostile, 'msg-1'); await observed.list(hostile, { afterSequence: 0, limit: 1 });
    expect(seen.length).toBeGreaterThan(0);
    for (const query of seen) {
      expect(query.sql).not.toContain(hostile.subjectId);
      expect(query.params).toContain(hostile.subjectId); expect(query.params).toContain(hostile.jobId);
    }
    expect(await port.get(scope, 'msg-1')).toBeNull();
  });

  it('rolls back allocator and exchange together after an insert failure', async () => {
    const faulty = createPostgresConversationPort({ query: db.query, transaction: fn => db.transaction(tx => fn({
      async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        if (/INSERT\s+INTO\s+reporting_chat_exchanges/i.test(sql)) throw new Error('provider credential=secret');
        return result;
      },
    })) });
    await expect(faulty.append(scope, row())).rejects.toMatchObject(storageError);
    expect(await port.get(scope, 'msg-1')).toBeNull();
    expect((await port.append(scope, row('after-rollback'))).sequence).toBe(1);
    await expect(faulty.append(scope, row('second-failure'))).rejects.toMatchObject(storageError);
    expect((await port.append(scope, row('after-second-rollback'))).sequence).toBe(2);
  });

  it('fails closed with fixed errors for malformed inputs and database failures', async () => {
    for (const input of [{ ...row(), inputDigest: 'secret' }, { ...row(), messageId: '../bad' }, { ...row(), reply: { ...row().reply, text: '' } }]) {
      await expect(port.append(scope, input)).rejects.toMatchObject(storageError);
    }
    await expect(port.get({ ...scope, subjectId: '' }, 'msg-1')).rejects.toMatchObject(storageError);
    await expect(port.get(scope, '../secret')).rejects.toMatchObject(storageError);
    const unavailable: AgentTransactionalSql = {
      query: async () => { throw new Error('postgres://user:password@secret'); },
      transaction: async () => { throw new Error('postgres://user:password@secret'); },
    };
    const broken = createPostgresConversationPort(unavailable);
    await expect(broken.get(scope, 'msg-1')).rejects.toMatchObject(storageError);
    await expect(broken.list(scope, { afterSequence: 0, limit: 1 })).rejects.toMatchObject(storageError);
    await expect(broken.append(scope, row())).rejects.toMatchObject(storageError);
    expect(await port.list(scope, { afterSequence: 0, limit: 50 })).toEqual([]);
  });

  it('validates persisted replies on lookup, replay and history', async () => {
    await port.append(scope, row());
    await db.query(`UPDATE reporting_chat_exchanges SET reply=jsonb_set(reply, '{text}', '""'::jsonb) WHERE subject_id=$1 AND job_id=$2`, [scope.subjectId, scope.jobId]);
    await expect(port.get(scope, 'msg-1')).rejects.toMatchObject(storageError);
    await expect(port.append(scope, row())).rejects.toMatchObject(storageError);
    await expect(port.list(scope, { afterSequence: 0, limit: 50 })).rejects.toMatchObject(storageError);
  });

  it('rejects unsafe persisted allocator integers without consuming another sequence', async () => {
    await port.append(scope, row());
    await db.query('UPDATE reporting_chat_scopes SET last_sequence=$3 WHERE subject_id=$1 AND job_id=$2', [scope.subjectId, scope.jobId, String(Number.MAX_SAFE_INTEGER)]);
    await expect(port.append(scope, row('overflow'))).rejects.toMatchObject(storageError);
    expect(await port.get(scope, 'overflow')).toBeNull();
    expect((await port.append(scope, row())).sequence).toBe(1);
  });
});

it('replays after closing and reopening a persistent PGlite database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chat-postgres-restart-'));
  let engine: PGlite | undefined;
  try {
    engine = new PGlite(directory); await engine.exec(migration);
    const saved = await createPostgresConversationPort(connectEngine(engine)).append(scope, row());
    await engine.close(); engine = undefined;
    engine = new PGlite(directory);
    const restarted = createPostgresConversationPort(connectEngine(engine));
    expect(await restarted.append(scope, { ...row(), inputDigest: 'e'.repeat(64) })).toEqual(saved);
    expect((await restarted.append(scope, row('next'))).sequence).toBe(2);
  } finally {
    if (engine) await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Explicit opt-in: only a local disposable PostgreSQL database, never a cloud URL.
// PGlite above does not establish independent-session race correctness.
const liveUrl = process.env.CHAT_PERSISTENCE_TEST_DATABASE_URL;
if (liveUrl) describe('PostgreSQL conversations: independent pinned sessions', () => {
  let pool: Pool;
  let db: AgentTransactionalSql;
  let created = false;
  const pids = new Set<number>();
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(liveUrl).hostname)) throw new Error('Chat persistence tests require an explicit local disposable PostgreSQL server');
    pool = new Pool({ connectionString: liveUrl, max: 16, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    await pool.query(migration); created = true;
    db = {
      async query<T>(sql: string, params?: unknown[]) { return { rows: (await pool.query(sql, params)).rows as T[] }; },
      async transaction<T>(fn: (tx: AgentSqlExecutor) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          pids.add((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
          const result = await fn({ async query<R>(sql: string, params?: unknown[]) { return { rows: (await client.query(sql, params)).rows as R[] }; } });
          await client.query('COMMIT'); return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
    };
  });
  beforeEach(async () => { await pool.query('TRUNCATE reporting_chat_exchanges, reporting_chat_scopes'); });
  afterAll(async () => {
    if (created) await pool.query('DROP TABLE reporting_chat_exchanges, reporting_chat_scopes');
    if (pool) await pool.end();
  });

  it('same-ID races preserve one original digest and reply across sessions', async () => {
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => createPostgresConversationPort(db).append(scope, {
      ...row(), inputDigest: (i % 2 ? 'a' : 'b').repeat(64), reply: { ...row().reply, text: `candidate-${i}` },
    })));
    expect(pids.size).toBeGreaterThan(1);
    expect(results.every(value => JSON.stringify(value) === JSON.stringify(results[0]))).toBe(true);
    expect(results[0]!.sequence).toBe(1);
    expect(await createPostgresConversationPort(db).list(scope, { afterSequence: 0, limit: 50 })).toHaveLength(1);
  });

  it('a blocked append waits for a prior writer rollback and then uses its uncommitted sequence', async () => {
    let inserted!: () => void;
    let release!: () => void;
    const insertion = new Promise<void>(resolve => { inserted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const faulty = createPostgresConversationPort({ query: db.query, transaction: fn => db.transaction(tx => fn({
      async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        if (/INSERT\s+INTO\s+reporting_chat_exchanges/i.test(sql)) {
          inserted(); await gate; throw new Error('rollback blocked writer');
        }
        return result;
      },
    })) });
    const failing = faulty.append(scope, row('rolled-back')).then(() => null, error => error);
    await insertion;
    const waiter = createPostgresConversationPort(db).append(scope, row('waiter'));
    try {
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const result = await pool.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query ILIKE '%reporting_chat_scopes%'`);
        if (result.rows.length) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      expect(await createPostgresConversationPort(db).get(scope, 'rolled-back')).toBeNull();
    } finally { release(); }
    expect(await failing).toMatchObject(storageError);
    expect((await waiter).sequence).toBe(1);
    expect((await createPostgresConversationPort(db).append(scope, row('after-wait'))).sequence).toBe(2);
  });

  it('distinct-ID races allocate consecutive scoped sequences while a rolled-back writer leaves no hole', async () => {
    const port = createPostgresConversationPort(db);
    const faulty = createPostgresConversationPort({ query: db.query, transaction: fn => db.transaction(tx => fn({
      async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        if (/INSERT\s+INTO\s+reporting_chat_exchanges/i.test(sql)) throw new Error('injected after SQL write');
        return result;
      },
    })) });
    const operations = await Promise.allSettled([
      faulty.append(scope, row('rollback')),
      ...Array.from({ length: 24 }, (_, i) => port.append(scope, row(`race-${i}`))),
    ]);
    expect(operations.filter(value => value.status === 'rejected')).toHaveLength(1);
    const rows = await port.list(scope, { afterSequence: 0, limit: 50 });
    expect(rows.map(value => value.sequence)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(await port.get(scope, 'rollback')).toBeNull();
    expect((await port.append({ ...scope, subjectId: 'bob' }, row())).sequence).toBe(1);
    expect((await port.append({ ...scope, jobId: 'job-2' }, row())).sequence).toBe(1);
  });
});
