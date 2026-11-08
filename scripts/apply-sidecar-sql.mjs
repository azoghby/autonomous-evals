/**
 * Applies Track B sidecar SQL files (not in the Drizzle journal) to ONE explicitly named Neon endpoint.
 * `npm run deploy` / `drizzle-kit migrate` never apply these; run this once per database, in order.
 *
 *   node scripts/apply-sidecar-sql.mjs <env-file> <expected-endpoint-id> <file.sql>...
 *
 * - Reads DATABASE_URL_UNPOOLED from <env-file> (direct host; never the -pooler host).
 * - Refuses unless that host starts with <expected-endpoint-id> (e.g. ep-blue-river-bd88lxip).
 * - Refuses any file containing DROP TABLE/SCHEMA/COLUMN, TRUNCATE or DELETE FROM.
 * - Each file runs in its own transaction; the first failure rolls back and stops.
 * - Prints file path + sha256 receipts only (never the URL).
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";

const DESTRUCTIVE = /\b(DROP\s+(TABLE|SCHEMA|COLUMN|INDEX|FUNCTION)|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+\S+\s+DROP)\b/i;

const [envFile, expected, ...files] = process.argv.slice(2);
if (!envFile || !expected || files.length === 0) {
  console.error("usage: node scripts/apply-sidecar-sql.mjs <env-file> <expected-endpoint-id> <file.sql>...");
  process.exit(2);
}
const parsed = config({ path: envFile, processEnv: {}, quiet: true }).parsed ?? {};
const url = parsed.DATABASE_URL_UNPOOLED;
if (!url || !new URL(url).host.startsWith(`${expected}.`)) {
  console.error("refusing: DATABASE_URL_UNPOOLED is missing or is not the expected direct endpoint");
  process.exit(2);
}
const sources = files.map((f) => ({ f, sql: readFileSync(f, "utf8") }));
for (const { f, sql } of sources) {
  if (DESTRUCTIVE.test(sql)) {
    console.error(`refusing: destructive statement in ${f}`);
    process.exit(2);
  }
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const { f, sql } of sources) {
    const sha = createHash("sha256").update(sql).digest("hex");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("COMMIT");
      console.log(`applied ${f} sha256=${sha}`);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`FAILED (rolled back) ${f} sha256=${sha}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await client.end();
}
