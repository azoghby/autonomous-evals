/**
 * Direct Postgres sessions for the sandbox runtime over @neondatabase/serverless (WebSocket, full
 * protocol: transactions, CREATE/DROP DATABASE). The HTTP driver cannot do CREATE DATABASE.
 * Always pass a NON-pooled connection string: CREATE DATABASE ... TEMPLATE and session settings
 * do not work through PgBouncer.
 */
import { Client, neonConfig } from "@neondatabase/serverless";
import type { SqlConn, SqlConnector, SqlResult } from "./types";

let wsConfigured = false;
function ensureWebSocket(): void {
  if (wsConfigured) return;
  wsConfigured = true;
  // Node >= 22 ships a global WebSocket; the driver needs it set explicitly.
  if (!neonConfig.webSocketConstructor && typeof globalThis.WebSocket === "function") {
    neonConfig.webSocketConstructor = globalThis.WebSocket as unknown as typeof neonConfig.webSocketConstructor;
  }
}

export const neonConnector: SqlConnector = async (connectionString) => {
  if (/-pooler\./.test(new URL(connectionString).hostname)) throw new Error("sandbox runtime requires a direct (non-pooled) connection");
  ensureWebSocket();
  const client = new Client({ connectionString });
  // An idle-socket error must not crash the process; the next query surfaces it.
  client.on("error", () => {});
  await client.connect();
  return clientConn(client);
};

function clientConn(client: Client): SqlConn {
  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<SqlResult<T>> {
      const r = await client.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
    },
    async exec(script: string): Promise<void> {
      await client.query(script);
    },
    async close(): Promise<void> {
      await client.end().catch(() => {});
    },
  };
}

/** Same database cluster, different database name. */
export function withDatabase(connectionString: string, database: string): string {
  const u = new URL(connectionString);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
