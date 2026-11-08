/**
 * Session-level pg advisory locks held across many statements (cron ticks, company agents, daily report).
 *
 * Must run on the direct (unpooled) Neon endpoint: PgBouncer transaction pooling on `-pooler` hosts hands each
 * statement to any server connection, so the lock and unlock can land on different sessions (same rationale as
 * packages/core/src/integration/eval-services.ts trackBDatabaseUrl). The unlock result is checked; when it is not
 * true the connection is destroyed instead of returned, which ends the session and drops any lock it still holds.
 */

export type LockOutcome<T> = { locked: true } | { locked: false; value: T };

interface LockClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(destroy?: boolean | Error): void;
}
export interface LockPool { connect(): Promise<LockClient>; end(): Promise<void> }

/** DATABASE_URL_UNPOOLED, falling back to DATABASE_URL only when unset. */
export function sessionLockDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.DATABASE_URL_UNPOOLED?.trim() || env.DATABASE_URL?.trim() || undefined;
}

async function defaultPool(): Promise<LockPool> {
  const { Pool } = await import("@neondatabase/serverless");
  return new Pool({ connectionString: sessionLockDatabaseUrl(), max: 1 }) as unknown as LockPool;
}

export async function withSessionAdvisoryLock<T>(
  key: bigint, fn: () => Promise<T>, makePool: () => Promise<LockPool> = defaultPool,
): Promise<LockOutcome<T>> {
  const pool = await makePool();
  let client: LockClient;
  try {
    client = await pool.connect();
  } catch (err) {
    // No client to release, but the pool still owns sockets/timers: end it so a failed connect does not leak.
    await pool.end().catch(() => {});
    throw err;
  }
  let destroy = false;
  try {
    const { rows } = await client.query("select pg_try_advisory_lock($1::bigint) as ok", [key.toString()]);
    if (!rows[0]?.ok) return { locked: true };
    try {
      return { locked: false, value: await fn() };
    } finally {
      const unlocked = await client.query("select pg_advisory_unlock($1::bigint) as ok", [key.toString()])
        .then((r) => r.rows[0]?.ok === true)
        .catch(() => false);
      if (!unlocked) {
        destroy = true;
        console.error("advisory unlock failed; discarding the connection so the lock is released", key.toString());
      }
    }
  } finally {
    client.release(destroy ? new Error("advisory unlock failed") : undefined);
    await pool.end().catch(() => {});
  }
}
