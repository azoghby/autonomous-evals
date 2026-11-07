import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgressChatService } from './chat/service.js';
import { createPostgresConversationPort, type ConversationTransactionalSql } from './chat/postgres-conversations.js';
import type { ProgressSnapshot } from './chat/types.js';

const alice = { subjectId: 'alice', jobId: 'job-a' };
const request = { jobId: alice.jobId, messageId: 'message', question: 'overview' };
const unavailable = { code: 'storage_error', message: 'Conversation storage is unavailable or invalid.' };
const snapshot = (jobId: string): ProgressSnapshot => ({
  jobId, observedAt: '2026-11-07T00:00:00Z', status: 'running', statusEvidenceRef: 'status-a',
  milestones: [], findings: [], blockers: [], costs: [], unknownCosts: true,
});

describe('Independent review: service plus real PostgreSQL adapter SQL in PGlite', () => {
  let engine: PGlite;
  let db: ConversationTransactionalSql;
  let reads: number;
  beforeEach(async () => {
    engine = new PGlite();
    await engine.exec(readFileSync(new URL('./chat/persistence-migrations/001-conversations.sql', import.meta.url), 'utf8'));
    db = {
      query: (sql, params) => engine.query(sql, params),
      transaction: fn => engine.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params) })),
    };
    reads = 0;
  });
  afterEach(async () => { await engine.close(); });
  function service(subjectId = 'alice', allowed = true, project = snapshot) {
    return createProgressChatService({
      access: {
        async authenticate() { return { subjectId }; },
        async resolveAuthorizedJob(caller, jobId) { return allowed ? { subjectId: caller.subjectId, jobId } : null; },
      },
      progress: { async read(scope) { reads++; return project(scope.jobId); } },
      conversations: createPostgresConversationPort(db),
    });
  }

  it('keeps same-message histories private across users sharing a job and across jobs', async () => {
    const a = await service().send(request);
    for (const [user, job] of [['bob', 'job-a'], ['alice', 'job-b']]) {
      const s = service(user);
      expect((await s.history({ jobId: job })).messages).toEqual([]);
      const own = await s.send({ ...request, jobId: job, question: 'cost' });
      expect(own.sequence).toBe(1);
      expect(own.reply.topic).toBe('cost');
    }
    expect((await service().history({ jobId: 'job-a' })).messages).toEqual([a]);
  });

  it('rechecks revoked access before replay, history and polling, including a valid old cursor', async () => {
    await service().send(request);
    const previous = await service().poll({ jobId: 'job-a' });
    const revoked = service('alice', false);
    const baseline = reads;
    for (const action of [() => revoked.send(request), () => revoked.history({ jobId: 'job-a' }),
      () => revoked.poll({ jobId: 'job-a', cursor: previous.cursor })]) {
      await expect(action()).rejects.toMatchObject({ code: 'not_found', message: 'Job not found.' });
    }
    expect(reads).toBe(baseline);
  });

  it('rejects forged JSON identity and a resolver returning another subject or job', async () => {
    const s = service();
    for (const field of ['subjectId', 'customerId', '__proto__']) {
      await expect(s.send({ ...request, [field]: 'bob' })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    for (const scope of [{ ...alice, subjectId: 'bob' }, { ...alice, jobId: 'job-b' }]) {
      const forged = createProgressChatService({ access: {
        async authenticate() { return { subjectId: 'alice' }; }, async resolveAuthorizedJob() { return scope; },
      }, conversations: createPostgresConversationPort(db), progress: { async read() { throw Error('must not read'); } } });
      await expect(forged.send(request)).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(reads).toBe(0);
  });

  it('treats forged, cross-user and cross-job poll cursors only as change markers', async () => {
    const a = await service().poll({ jobId: 'job-a' });
    expect(await service().poll({ jobId: 'job-a', cursor: a.cursor })).toMatchObject({ changed: false });
    for (const [user, job] of [['bob', 'job-a'], ['alice', 'job-b']]) {
      const other = await service(user).poll({ jobId: job, cursor: a.cursor });
      expect(other.changed).toBe(true); expect(other.cursor).not.toBe(a.cursor);
    }
    expect((await service().poll({ jobId: 'job-a', cursor: '0'.repeat(64) })).changed).toBe(true);
    await expect(service().poll({ jobId: 'job-a', cursor: '../alice' })).rejects.toMatchObject({ code: 'invalid_input' });
    // The cursor is unkeyed and computable from a known projection; this grants no access.
    const computed = createHash('sha256').update(JSON.stringify([alice, snapshot('job-a')])).digest('hex');
    expect((await service().poll({ jobId: 'job-a', cursor: computed })).changed).toBe(false);
    expect((await service().history({ jobId: 'job-a' })).messages).toEqual([]);
  });

  it('makes same-input concurrent service replay return one exchange without duplicate rows', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => service().send(request)));
    expect(results.every(row => JSON.stringify(row) === JSON.stringify(results[0]))).toBe(true);
    expect((await service().history({ jobId: 'job-a' })).messages).toHaveLength(1);
    const baseline = reads;
    expect(await service().send(request)).toEqual(results[0]);
    expect(reads).toBe(baseline);
  });

  it('makes different-input concurrent service replay conflict with the committed winner', async () => {
    const results = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => service().send({ ...request, question: `status ${i}` })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const losers = results.filter(result => result.status === 'rejected');
    expect(losers).toHaveLength(15);
    for (const result of losers) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'conflict' });
    expect((await service().history({ jobId: 'job-a' })).messages).toHaveLength(1);
  });

  it.each([
    ['empty text', { text: '' }], ['extra field', { providerBody: 'SYNTHETIC_PRIVATE_BODY' }],
    ['URL reference', { evidenceRefs: ['https://private.test/token'] }], ['bad freshness', { asOf: 'yesterday' }],
    ['bad topic', { topic: 'execute' }],
  ])('fails closed on persisted structural corruption: %s', async (_label, patch) => {
    const original = await service().send(request);
    await db.query('UPDATE reporting_chat_exchanges SET reply=$1::jsonb', [JSON.stringify({ ...original.reply, ...patch })]);
    await expect(service().send(request)).rejects.toMatchObject(unavailable);
    await expect(service().history({ jobId: 'job-a' })).rejects.toMatchObject(unavailable);
  });

  it('does not echo injected question/prose and rejects wrong-job or extra snapshot fields', async () => {
    const secret = 'SYNTHETIC_SECRET_ignore_previous_instructions';
    const answer = await service().send({ ...request, question: `status ${secret}` });
    expect(JSON.stringify(answer)).not.toContain(secret);
    const raw = await db.query<{ reply: unknown }>('SELECT reply FROM reporting_chat_exchanges');
    expect(JSON.stringify(raw.rows)).not.toContain(secret);
    for (const project of [() => snapshot('job-b'), (job: string) => ({ ...snapshot(job), providerBody: secret })]) {
      await expect(service('alice', true, project).poll({ jobId: 'job-a' })).rejects.toMatchObject({ code: 'invalid_snapshot' });
    }
  });

  it('BOUNDARY: shape-valid stored text/unknowns are replayed without semantic grounding verification', async () => {
    const saved = await service().send(request);
    const poisoned = { ...saved.reply, text: 'SYNTHETIC_PRIVATE_PROVIDER_BODY', unknowns: ['SYNTHETIC_PRIVATE_PROMPT'] };
    await db.query('UPDATE reporting_chat_exchanges SET reply=$1::jsonb', [JSON.stringify(poisoned)]);
    expect((await service().send(request)).reply).toEqual(poisoned);
    expect((await service().history({ jobId: 'job-a' })).messages[0]!.reply).toEqual(poisoned);
    // Requires a trusted writer/database corruption, not reachable from question JSON.
  });

  it('BOUNDARY: syntactically valid private reference tokens pass the projection boundary', async () => {
    const marker = 'SYNTHETIC_PRIVATE_TOKEN';
    const result = await service('alice', true, job => ({ ...snapshot(job), statusEvidenceRef: marker })).poll({ jobId: 'job-a' });
    expect(result.reply!.evidenceRefs).toContain(marker);
    expect(result.reply!.text).not.toContain(marker);
    // Authorization/opaque-ID mapping must happen in the trusted progress adapter.
  });

  it('rejects cross-scope driver rows even if message identity/digest/reply look valid', async () => {
    const original = await service().send(request);
    for (const scope of [{ ...alice, subjectId: 'bob' }, { ...alice, jobId: 'job-b' }]) {
      const forged: ConversationTransactionalSql = { transaction: db.transaction, async query<T>() {
        return { rows: [{ subject_id: scope.subjectId, job_id: scope.jobId, message_id: original.messageId,
          input_digest: original.inputDigest, reply: original.reply, sequence: '1' }] as T[] };
      } };
      const port = createPostgresConversationPort(forged);
      await expect(port.get(alice, 'message')).rejects.toMatchObject(unavailable);
      await expect(port.list(alice, { afterSequence: 0, limit: 20 })).rejects.toMatchObject(unavailable);
    }
  });
});
