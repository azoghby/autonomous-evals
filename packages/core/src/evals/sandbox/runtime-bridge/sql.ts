import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { assertReadOnlySql } from '../../../sandbox/runtime/sql-text.js';

/** Only the owning runtime may supply this handle. Never expose the live DB to an agent. */
export interface SqlImageSource { dumpDataDir(): Promise<Blob> }
export interface RetainedSqlImage {
  digest: string;
  open(): Promise<{ query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>; close(): Promise<void> }>;
}
/** A full PostgreSQL data-directory image, not sampled rows or reconstructed DDL.
 * Local PGlite implementation; hosted Neon requires an independently retained DB backend. */
export async function capturePGliteImage(source: SqlImageSource, maxRows = 5000): Promise<RetainedSqlImage> {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new Error('snapshot_row_bound_invalid');
  const exported = await source.dumpDataDir();
  const bytes = await exported.arrayBuffer();
  const digest = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  const image = new Blob([bytes]);
  return {
    digest,
    async open() {
      const db = new PGlite({ loadDataDir: image });
      await db.waitReady;
      let closed = false, tail: Promise<unknown> = Promise.resolve();
      const serial = <T>(fn: () => Promise<T>) => {
        const next = tail.then(fn); tail = next.catch(() => undefined); return next;
      };
      return {
        query(sql, params = []) {
          const values = structuredClone(params);
          if (closed) return Promise.reject(new Error('snapshot_released'));
          return serial(async () => {
            const stmt = assertReadOnlySql(sql);
            await db.query('BEGIN READ ONLY');
            try {
              await db.query('SET LOCAL statement_timeout = 5000');
              const result = await db.query<Record<string, unknown>>(stmt, values);
              // Never silently truncate and then attest allRows.
              if (result.rows.length > maxRows) throw new Error('snapshot_row_bound_exceeded');
              return structuredClone(result.rows);
            } finally { await db.query('ROLLBACK'); }
          });
        },
        async close() {
          if (closed) return tail.then(() => undefined);
          closed = true;
          return serial(() => db.close());
        },
      };
    },
  };
}
