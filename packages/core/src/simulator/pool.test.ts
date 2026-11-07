import { describe, expect, it, vi } from 'vitest';
import { pooledCalendarDatabase, type SqlPool } from './pool';
import type { QueryExecutor } from './postgres';

function setup() {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ value: 1 }] }));
  const release = vi.fn();
  const pool: SqlPool = { query: vi.fn(async () => ({ rows: [] })), connect: vi.fn(async () => ({ query, release })) };
  return { db: pooledCalendarDatabase(pool), query, release, pool };
}
describe('pooled simulator transactions', () => {
  it('uses one checked-out connection for every statement and commits before releasing', async () => {
    const s = setup();
    const value = await s.db.transaction(async (tx) => {
      await tx.query('SELECT 1 FOR UPDATE');
      return (await tx.query<{ value: number }>('SELECT $1', [1])).rows[0].value;
    });
    expect(value).toBe(1);
    expect(s.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SELECT 1 FOR UPDATE', 'SELECT $1', 'COMMIT']);
    expect(s.pool.query).not.toHaveBeenCalled();
    expect(s.pool.connect).toHaveBeenCalledTimes(1);
    expect(s.release).toHaveBeenCalledWith(undefined);
  });
  it('rolls back callback failures without committing or retrying', async () => {
    const s = setup(); const callback = vi.fn(async () => { throw new Error('original failure'); });
    await expect(s.db.transaction(callback)).rejects.toThrow('original failure');
    expect(s.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(s.release).toHaveBeenCalledTimes(1);
  });
  it('discards the connection if commit is ambiguous', async () => {
    const s = setup(); s.query.mockImplementation(async (sql) => {
      if (sql === 'COMMIT') throw new Error('network loss');
      return { rows: [] };
    });
    await expect(s.db.transaction(async () => 'result')).rejects.toThrow('network loss');
    expect(s.release).toHaveBeenCalledWith(expect.any(Error));
  });
  it('preserves the original error and discards the connection when rollback fails', async () => {
    const s = setup(); s.query.mockImplementation(async (sql) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failure');
      return { rows: [] };
    });
    await expect(s.db.transaction(async () => { throw new Error('original failure'); })).rejects.toThrow('original failure');
    expect(s.release).toHaveBeenCalledWith(expect.any(Error));
  });
  it('rejects a transaction executor retained past its lifetime', async () => {
    const s = setup(); let escaped: QueryExecutor | undefined;
    await s.db.transaction(async (tx) => { escaped = tx; });
    await expect(escaped!.query('SELECT 1')).rejects.toThrow('calendar_transaction_closed');
    expect(s.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
  });
});
