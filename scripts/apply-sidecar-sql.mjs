/**
 * Apply sidecar SQL to one explicitly named direct endpoint, one transaction per file.
 * Default destructive refusal remains in force. --reviewed-constraints admits only
 * the two code-pinned canonical constraint replacement files. --dry-run validates
 * SQL and the endpoint label without reading an environment file or opening a DB.
 *
 * node scripts/apply-sidecar-sql.mjs [--dry-run] [--reviewed-constraints] <env-file> <expected-endpoint-id> <file.sql>...
 */
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PolicyError, parseArguments, validateSqlSource, validateDatabaseUrl } from "./sidecar-sql-policy.mjs";

export async function run(argv, {
  readSql = async (file) => ({ sql: await readFile(file, "utf8"), realPath: await realpath(file) }),
  readEnvironment = async (envFile) => {
    const { parse } = await import("dotenv");
    return parse(await readFile(envFile));
  },
  createClient = async (url) => {
    const { default: pg } = await import("pg");
    return new pg.Client({ connectionString: url });
  },
  log = console.log,
  error = console.error,
} = {}) {
  let options;
  let sources;
  let url;
  try {
    options = parseArguments(argv);
    sources = [];
    const seen = new Set();
    for (const file of options.files) {
      const source = await readSql(file);
      const identity = source.realPath ?? resolve(file);
      if (seen.has(identity)) throw new PolicyError("refusing: duplicate SQL file");
      seen.add(identity);
      sources.push(validateSqlSource({ ...source, file }, options));
    }
    if (options.dryRun) {
      log(`dry-run endpoint=${options.expected}; no environment read or database connection`);
      for (const { f, sha } of sources) log(`validated ${f} sha256=${sha}`);
      return 0;
    }
    const parsed = await readEnvironment(options.envFile);
    url = validateDatabaseUrl(parsed.DATABASE_URL_UNPOOLED, options.expected);
  } catch (cause) {
    // Only policy-owned messages may reach output; filesystem/provider errors can
    // contain secrets or arbitrary SQL. Never print their message or stack.
    error(cause instanceof PolicyError ? cause.message : "refusing: could not validate migration inputs");
    return 2;
  }

  let client;
  let status = 0;
  try {
    client = await createClient(url);
    await client.connect();
    for (const { f, sql, sha } of sources) {
      let began = false;
      let commitAttempted = false;
      try {
        await client.query("BEGIN");
        began = true;
        await client.query(sql);
        commitAttempted = true;
        await client.query("COMMIT");
        log(`applied ${f} sha256=${sha}`);
      } catch {
        let rolledBack = false;
        if (began) {
          try { await client.query("ROLLBACK"); rolledBack = true; } catch { /* stop even if rollback fails */ }
        }
        error(`FAILED (${commitAttempted ? "commit outcome unknown; inspect database before retry" : rolledBack ? "rolled back" : "transaction not confirmed"}) ${f} sha256=${sha}`);
        status = 1;
        break;
      }
    }
  } catch {
    error("FAILED: database connection or execution failed");
    status = 1;
  } finally {
    if (client) {
      try { await client.end(); } catch { error("FAILED: database connection cleanup failed"); status = 1; }
    }
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
