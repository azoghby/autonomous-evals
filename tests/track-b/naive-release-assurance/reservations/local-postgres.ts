import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import type { AgentTransactionalSql, AgentSqlExecutor } from '../../../../packages/core/src/agents/postgres-ports';

/** Native PostgreSQL only. No external database URLs, TCP, credentials or downloads. */
export async function localPostgres() {
  const installed = '/tmp/agent-persistence-runtime/node_modules/@embedded-postgres/darwin-arm64/native/bin';
  const bin = process.env.RESERVATIONS_PG_BIN ?? (existsSync(installed) ? installed : '');
  const work = mkdtempSync(join(tmpdir(), 'reservation-sql-'));
  const data = join(work, 'data');
  const command = (name: string, args: string[]) => {
    const result = spawnSync(bin ? join(bin, name) : name, args, { encoding: 'utf8', timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error(`${name} failed: ${result.error?.message ?? result.stderr ?? result.stdout}. Set RESERVATIONS_PG_BIN to installed PostgreSQL binaries; this suite never downloads them.`);
  };
  const clients: pg.Client[] = [];
  let running = false;
  try {
    command('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
    // Every disposable cluster has a different socket directory. TCP is disabled.
    command('pg_ctl', ['-D', data, '-l', join(work, 'postgres.log'), '-o', `-h '' -k ${work} -c fsync=on -c synchronous_commit=on`, '-w', 'start']);
    running = true;
    const connect = async () => {
      const client = new pg.Client({ host: work, database: 'postgres', user: 'postgres', connectionTimeoutMillis: 5000, query_timeout: 10_000 });
      await client.connect();
      clients.push(client);
      await client.query("SET statement_timeout = '8s'; SET lock_timeout = '6s'");
      return client;
    };
    const observer = await connect();
    await observer.query(readFileSync(new URL('../../../../packages/core/src/agents/persistence-migrations/001-agent-persistence.sql', import.meta.url), 'utf8'));
    const sessions = await Promise.all(Array.from({ length: 4 }, connect));
    const ports = sessions.map(client => ({
      query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as T[] }),
      transaction: async <T>(fn: (tx: AgentSqlExecutor) => Promise<T>): Promise<T> => {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        try {
          const result = await fn({ query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as R[] }) });
          await client.query('COMMIT');
          return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
      },
    } satisfies AgentTransactionalSql));
    return {
      observer, sessions, ports,
      async close() {
        await Promise.all(clients.map(client => client.end()));
        command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
        running = false;
        rmSync(work, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await Promise.allSettled(clients.map(client => client.end()));
    if (running) command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
}
