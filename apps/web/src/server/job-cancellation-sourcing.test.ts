import { describe, expect, it, vi } from 'vitest';
import { requestJobCancellation } from './job-cancellation';
import { sourcingLockKey, withSourcingLocks } from './expert-sourcing-locks';

describe('cancellation and expert dispatch ordering', () => {
  it('uses the same canonical job mutex before accessing the job row', async () => {
    const jobId = 'ABCDEF11-1111-4111-8111-111111111111';
    let dispatchKey: unknown;
    await withSourcingLocks([`expert-sourcing:job:${jobId}`], async () => {}, async () => ({
      connect: async () => ({
        query: async (sql, params) => {
          if (sql.includes('pg_try_advisory_lock')) dispatchKey = params?.[0];
          return { rows: [{ ok: true, pid: 42 }] };
        }, release: () => {},
      }), end: async () => {},
    }));
    let unblock!: () => void;
    const pending = new Promise<void>(resolve => { unblock = resolve; });
    let entered!: () => void;
    const lockEntered = new Promise<void>(resolve => { entered = resolve; });
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        expect(params).toEqual([dispatchKey]);
        expect(dispatchKey).toBe(sourcingLockKey(`expert-sourcing:job:${jobId.toLowerCase()}`));
        entered(); await pending;
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const cancellation = requestJobCancellation(jobId, { id: 'owner' }, 'stop', { connect: async () => ({ query, release }) });
    await lockEntered;
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM jobs'))).toBe(false);
    unblock();
    expect(await cancellation).toMatchObject({ ok: false, status: 404 });
    expect(query.mock.calls.find(([sql]) => sql.includes('FROM jobs'))?.[1]).toEqual([jobId.toLowerCase()]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back without touching job state if lock acquisition fails', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) throw new Error('lock unavailable');
      return { rows: [] };
    });
    await expect(requestJobCancellation('job', { id: 'owner' }, 'stop', { connect: async () => ({ query, release: () => {} }) })).rejects.toThrow('lock unavailable');
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SELECT pg_advisory_xact_lock($1::bigint)', 'ROLLBACK']);
  });
});
