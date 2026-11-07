import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { PostgresBranchLedger } from './branch-ledger.js';
import { NeonBranchService, type BranchOwnership } from './neon.js';
import type { SqlPool } from './pool.js';

const initial: BranchOwnership = {
  jobId: 'job-1', projectId: 'project-1', parentId: 'br-seed',
  name: 'eval-job-00000000-0000-0000-0000-000000000001', state: 'creating', createAttempts: 1,
};
const ready: BranchOwnership = { ...initial, state: 'ready', branchId: 'br-owned' };
const row = (r: BranchOwnership) => ({ job_id: r.jobId, project_id: r.projectId, parent_id: r.parentId,
  name: r.name, branch_id: r.branchId ?? null, state: r.state, create_attempts: r.createAttempts ?? null });

async function database() {
  const db = new PGlite();
  await db.exec(await readFile(new URL('./ledger-migrations/001_branch_ownership.sql', import.meta.url), 'utf8'));
  const events: string[] = [];
  // PGlite is one session and has no advisory locks: only intercept lock SQL.
  // All ownership queries, constraints and autocommit behavior use real PostgreSQL.
  const query = async (sql: string, params?: unknown[]) => {
    events.push(sql);
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (sql.includes('pg_advisory_lock')) return { rows: [] };
    return db.query(sql, params);
  };
  const release = vi.fn();
  const pool: SqlPool = { query: (sql, params) => db.query(sql, params), connect: async () => ({ query, release }) };
  return { db, pool, events, release, ledger: new PostgresBranchLedger(pool) };
}

describe('application branch ledger SQL (PGlite; locks intercepted)', () => {
  it('integrates service retries with durable creation and deletion transitions', async () => {
    const s = await database();
    try {
      let branch: Record<string, unknown>;
      let creates = 0; let deletes = 0;
      const api = { call: vi.fn(async (method: 'GET' | 'POST' | 'DELETE', _path: string, body?: unknown) => {
        if (method === 'POST') {
          if (++creates === 1) return { status: 423 };
          branch = { ...(body as { branch: object }).branch, id: 'br-owned', project_id: 'project-1', default: false };
          return { status: 201, body: { branch } };
        }
        if (method === 'GET') return { status: 200, body: { branch } };
        return { status: ++deletes === 1 ? 503 : 204 };
      }) };
      const service = new NeonBranchService(api, s.ledger, 'project-1', 'br-seed');
      await expect(service.createJobBranch('job-1')).rejects.toThrow('branch_retryable_response');
      await expect(service.createJobBranch('job-1')).resolves.toMatchObject({ state: 'ready', createAttempts: 2 });
      await expect(service.deleteJobBranch('job-1')).rejects.toThrow('branch_retryable_response');
      await expect(service.deleteJobBranch('job-1')).resolves.toEqual({ state: 'deleted' });
      expect((await s.ledger.findOwnedBranch('br-owned'))?.state).toBe('deleted');
    } finally { await s.db.close(); }
  });
  it('commits intent before cloud POST and preserves it after ambiguous failure and fresh ledger instance', async () => {
    const s = await database();
    try {
      const api = { call: vi.fn(async () => {
        const stored = await s.db.query<{ state: string }>('SELECT state FROM app_branch_ownership');
        expect(stored.rows[0].state).toBe('creating');
        throw new Error('ambiguous');
      }) };
      await expect(new NeonBranchService(api, s.ledger, 'project-1', 'br-seed').createJobBranch('job-1')).rejects.toThrow('ambiguous');
      await expect(new NeonBranchService(api, new PostgresBranchLedger(s.pool), 'project-1', 'br-seed').createJobBranch('job-1')).rejects.toThrow('branch_requires_reconciliation');
      expect(api.call).toHaveBeenCalledTimes(1);
      expect(s.events.some((sql) => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql))).toBe(false);
    } finally { await s.db.close(); }
  });
  it('persists each put across callback failure; supports lookup, updates and tombstones', async () => {
    const s = await database();
    try {
      await expect(s.ledger.withJobLock('job-1', async (_, put) => {
        await put(initial); await put(ready); throw new Error('crash');
      })).rejects.toThrow('crash');
      expect(await s.ledger.findOwnedBranch('br-owned')).toEqual(ready);
      await s.ledger.withJobLock('job-1', async (record, put) => {
        expect(record).toEqual(ready);
        await put({ ...ready, state: 'delete_requested' }); await put({ ...ready, state: 'deleted' });
      });
      expect((await s.ledger.findOwnedBranch('br-owned'))?.state).toBe('deleted');
      expect(await s.ledger.findOwnedBranch('br-absent')).toBeUndefined();
    } finally { await s.db.close(); }
  });
  it('enforces unique branch ownership, immutable identity and non-regressing states in SQL', async () => {
    const s = await database();
    try {
      await s.ledger.withJobLock('job-1', async (_, put) => { await put(initial); await put(ready); });
      for (const changed of [{ ...ready, projectId: 'other' }, { ...ready, branchId: 'br-other' }, initial]) {
        await expect(s.ledger.withJobLock('job-1', async (_, put) => put(changed))).rejects.toThrow('branch_ledger_ownership_conflict');
      }
      await expect(s.ledger.withJobLock('job-2', async (_, put) => put({ ...ready, jobId: 'job-2', name: initial.name.replace(/1$/, '2') }))).rejects.toThrow('branch_ledger_sql_failed');
      await expect(s.db.query("INSERT INTO app_branch_ownership (job_id,project_id,parent_id,name,state) VALUES ('bad','project-1','br-seed',$1,'ready')", [initial.name.replace(/1$/, '3')])).rejects.toThrow();
      expect(await s.ledger.findOwnedBranch('br-owned')).toEqual(ready);
    } finally { await s.db.close(); }
  });
  it('allows bounded explicit retries but cannot reset attempts or restart ambiguous creating', async () => {
    const s = await database();
    try {
      await s.ledger.withJobLock('job-1', async (_, put) => {
        await put(initial);
        await put({ ...initial, state: 'retryable' });
        await put({ ...initial, createAttempts: 2 });
        await put({ ...initial, state: 'retryable', createAttempts: 2 });
        await put({ ...initial, createAttempts: 3 });
      });
      for (const changed of [{ ...initial, createAttempts: 1 }, { ...initial, createAttempts: 4 }]) {
        await expect(s.ledger.withJobLock('job-1', async (_, put) => put(changed))).rejects.toThrow();
      }
      await expect(s.db.query('UPDATE app_branch_ownership SET create_attempts = 4')).rejects.toThrow();
      await s.ledger.withJobLock('job-1', async (record) => { expect(record?.createAttempts).toBe(3); });
    } finally { await s.db.close(); }
  });
});

function pinned() {
  const events: string[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    events.push(sql);
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (sql.startsWith('INSERT')) return { rows: [row({ ...initial, jobId: params![0] as string })] };
    return { rows: [] as unknown[] };
  });
  const release = vi.fn();
  const pool: SqlPool = { query: vi.fn(async () => ({ rows: [] })), connect: vi.fn(async () => ({ query, release })) };
  return { events, query, release, pool, ledger: new PostgresBranchLedger(pool) };
}

describe('pinned session locking and lifetime (injected driver)', () => {
  it('pins lock/read/put/unlock; drains unawaited writes and refuses escaped puts', async () => {
    const s = pinned(); let escaped!: (r: BranchOwnership) => Promise<void>;
    await s.ledger.withJobLock('job-1', async (_, put) => { escaped = put; void put(initial); });
    expect(s.events.map((sql) => sql.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'SELECT pg_advisory_lock(hashtextextended($1,', 'SELECT job_id,', 'INSERT INTO', 'SELECT pg_advisory_unlock(hashtextextended($1,',
    ]);
    expect(s.pool.query).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalledWith(undefined);
    await expect(escaped(initial)).rejects.toThrow('branch_ledger_closed');
    expect(s.query).toHaveBeenCalledTimes(4);
  });
  it('does not resolve put or unlock before the autocommitted query completes', async () => {
    const s = pinned(); const original = s.query.getMockImplementation()!;
    let complete!: () => void;
    const commit = new Promise<void>((resolve) => { complete = resolve; });
    s.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('INSERT')) await commit;
      return original(sql, params);
    });
    let putResolved = false;
    const operation = s.ledger.withJobLock('job-1', async (_, put) => {
      await put(initial); putResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(putResolved).toBe(false);
    expect(s.events.some((sql) => sql.includes('pg_advisory_unlock'))).toBe(false);
    expect(s.release).not.toHaveBeenCalled();
    complete(); await operation; expect(putResolved).toBe(true);
  });
  it('fails closed if callback swallows a database write failure', async () => {
    const s = pinned(); const original = s.query.getMockImplementation()!;
    s.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('INSERT')) throw new Error('secret');
      return original(sql, params);
    });
    await expect(s.ledger.withJobLock('job-1', async (_, put) => {
      await put(initial).catch(() => undefined);
      return 'apparently successful';
    })).rejects.toThrow('branch_ledger_sql_failed');
    expect(s.release).toHaveBeenCalledWith(expect.any(Error));
  });
  it('validates stored rows and put job identity before use', async () => {
    const s = pinned();
    s.query.mockImplementation(async (sql) => ({ rows: sql.includes('WHERE job_id') ? [{ ...row(initial), state: 'unknown' }] : sql.includes('pg_advisory_unlock') ? [{ unlocked: true }] : [] }));
    const callback = vi.fn();
    await expect(s.ledger.withJobLock('job-1', callback)).rejects.toThrow('branch_ledger_invalid_record');
    expect(callback).not.toHaveBeenCalled();
    const t = pinned();
    await expect(t.ledger.withJobLock('job-1', async (_, put) => put({ ...initial, jobId: 'job-2' }))).rejects.toThrow('branch_ledger_job_mismatch');
    expect(t.events.some((sql) => sql.startsWith('INSERT'))).toBe(false);
  });
  it.each(['acquire', 'write', 'unlock', 'false-unlock'])('discards on %s failure without leaking SQL errors', async (stage) => {
    const s = pinned(); const original = s.query.getMockImplementation()!;
    s.query.mockImplementation(async (sql, params) => {
      if ((stage === 'acquire' && sql.includes('pg_advisory_lock')) || (stage === 'write' && sql.startsWith('INSERT')) || (stage === 'unlock' && sql.includes('pg_advisory_unlock'))) throw new Error('secret database detail');
      if (stage === 'false-unlock' && sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: false }] };
      return original(sql, params);
    });
    await expect(s.ledger.withJobLock('job-1', async (_, put) => put(initial))).rejects.toThrow(/^branch_ledger_/);
    expect(s.release).toHaveBeenCalledWith(expect.any(Error));
  });
  it('preserves callback errors when unlock/release also fail; attempts destroy after release throws', async () => {
    const s = pinned(); s.release.mockImplementationOnce(() => { throw new Error('secret'); });
    await expect(s.ledger.withJobLock('job-1', async () => { throw new Error('callback'); })).rejects.toThrow('callback');
    expect(s.release).toHaveBeenLastCalledWith(expect.any(Error));
    const t = pinned(); t.release.mockImplementationOnce(() => { throw new Error('secret'); });
    await expect(t.ledger.withJobLock('job-1', async () => 1)).rejects.toThrow('branch_ledger_release_failed');
  });
  it('holds a second same-job callback behind lock acquisition (simulated mutex, not real PG concurrency)', async () => {
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    let connects = 0; let enteredSecond = false;
    const pool: SqlPool = { query: async () => ({ rows: [] }), connect: async () => {
      const second = ++connects === 2;
      return { release() {}, async query(sql) {
        if (second && sql.includes('pg_advisory_lock')) await gate;
        if (sql.includes('pg_advisory_unlock')) { if (!second) unlock(); return { rows: [{ unlocked: true }] }; }
        return { rows: [] };
      } };
    } };
    const ledger = new PostgresBranchLedger(pool);
    let finish!: () => void;
    const firstGate = new Promise<void>((resolve) => { finish = resolve; });
    const first = ledger.withJobLock('job-1', async () => firstGate);
    const second = ledger.withJobLock('job-1', async () => { enteredSecond = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(enteredSecond).toBe(false); finish(); await Promise.all([first, second]);
    expect(enteredSecond).toBe(true);
  });
});
