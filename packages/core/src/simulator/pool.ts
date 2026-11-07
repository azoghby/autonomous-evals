import type { QueryExecutor, QueryResult, TransactionalDatabase } from './postgres.js';

/** Compatible with a pg-style Pool; a Neon HTTP query function is not sufficient. */
export interface SqlConnection {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(error?: Error): void;
}
export interface SqlPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<SqlConnection>;
}

export function pooledCalendarDatabase(pool: SqlPool): TransactionalDatabase {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
      const connection = await pool.connect();
      let active = false;
      let discard: Error | undefined;
      try {
        await connection.query('BEGIN');
        active = true;
        const tx: QueryExecutor = {
          async query<R>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
            if (!active) throw new Error('calendar_transaction_closed');
            const result = await connection.query(sql, params);
            return { rows: result.rows as R[] };
          },
        };
        const result = await fn(tx);
        active = false;
        try { await connection.query('COMMIT'); }
        catch (error) {
          // A failed COMMIT may be ambiguous. Never retry this callback automatically.
          discard = new Error('calendar_commit_failed');
          throw error;
        }
        return result;
      } catch (error) {
        active = false;
        try { await connection.query('ROLLBACK'); }
        catch { discard = new Error('calendar_rollback_failed'); }
        throw error;
      } finally {
        active = false;
        connection.release(discard);
      }
    },
  };
}
