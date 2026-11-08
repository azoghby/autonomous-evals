import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import type { AgentSqlExecutor, AgentTransactionalSql } from '../agents/postgres-ports';

/** Independent native PostgreSQL backends on a disposable Unix socket. No TCP or downloads. */
export async function localPostgres() {
  const installed = '/tmp/agent-persistence-runtime/node_modules/@embedded-postgres/darwin-arm64/native/bin';
  const bin = process.env.CONTINUATION_PG_BIN ?? (existsSync(installed) ? installed : '');
  const work = mkdtempSync(join(tmpdir(), 'continuation-sql-'));
  const data = join(work, 'data');
  const command = (name: string, args: string[]) => {
    const result = spawnSync(bin ? join(bin, name) : name, args, { encoding: 'utf8', timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error(`${name}: ${result.error?.message ?? result.stderr}. Set CONTINUATION_PG_BIN to installed native PostgreSQL binaries; this suite never downloads them.`);
  };
  let clients: pg.Client[] = [];
  let running = false;
  const connect = async () => {
    const client = new pg.Client({ host: work, database: 'postgres', user: 'postgres', connectionTimeoutMillis: 5000, query_timeout: 10_000 });
    await client.connect(); clients.push(client);
    await client.query("SET statement_timeout = '8s'; SET lock_timeout = '6s'");
    return client;
  };
  const port = (client: pg.Client): AgentTransactionalSql => ({
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as T[] }),
    transaction: async <T>(fn: (tx: AgentSqlExecutor) => Promise<T>): Promise<T> => {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      try {
        const result = await fn({ query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as R[] }) });
        await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    },
  });
  const opened = async () => {
    const sessions = await Promise.all([connect(), connect(), connect()]);
    return { observer: sessions[2], ports: sessions.slice(0, 2).map(port) };
  };
  try {
    command('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
    command('pg_ctl', ['-D', data, '-l', join(work, 'postgres.log'), '-o', `-h '' -k ${work} -c fsync=on -c synchronous_commit=on`, '-w', 'start']);
    running = true;
    const initial = await opened();
    for (const file of ['agents/persistence-migrations/001-agent-persistence.sql', 'evals/integration/migrations/001-text-integration.sql']) {
      await initial.observer.query(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    }
    return {
      ...initial,
      async restart() {
        await Promise.all(clients.map(client => client.end())); clients = [];
        command('pg_ctl', ['-D', data, '-l', join(work, 'postgres.log'), '-m', 'fast', '-w', 'restart']);
        return opened();
      },
      async close() {
        await Promise.all(clients.map(client => client.end())); clients = [];
        command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); running = false;
        rmSync(work, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await Promise.allSettled(clients.map(client => client.end()));
    if (running) command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(work, { recursive: true, force: true }); throw error;
  }
}
