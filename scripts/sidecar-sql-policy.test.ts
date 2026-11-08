import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
// The production entrypoint must remain inert when imported by offline tests.
import { run } from "./apply-sidecar-sql.mjs";
import { validateSqlSource } from "./sidecar-sql-policy.mjs";

const reviewedFiles = [
  "docs/naive-design-recovery-integration/sql/001-design-stage-recovery.sql",
  "docs/naive-run-recovery-integration/sql/001-run-recovery.sql",
];
const expected = "ep-test-fixture";
const url = `postgresql://user:private-password@${expected}.us-east-2.aws.neon.tech/app`;
const argv = (...files: string[]) => ["unused.env", expected, ...files];
const source = async (file: string) => ({
  file,
  sql: await readFile(file, "utf8"),
  realPath: await realpath(file),
});

function harness(sql: Record<string, string>, failSql?: string) {
  const client = {
    connect: vi.fn(async () => {}),
    query: vi.fn(async (statement: string) => {
      if (statement === failSql) throw new Error(`provider leaked ${url}`);
    }),
    end: vi.fn(async () => {}),
  };
  const deps = {
    readSql: vi.fn(async (file: string) => ({ sql: sql[file], realPath: resolve(file) })),
    readEnvironment: vi.fn(async () => ({ DATABASE_URL_UNPOOLED: url })),
    createClient: vi.fn(async () => client),
    log: vi.fn(),
    error: vi.fn(),
  };
  return { client, deps };
}

describe("reviewed sidecar constraint exceptions", () => {
  it.each(reviewedFiles)("requires explicit opt-in for actual reviewed file %s", async (file) => {
    const input = await source(file);
    expect(() => validateSqlSource(input)).toThrow();
    expect(validateSqlSource(input, { reviewedConstraints: true })).toMatchObject({
      f: file,
      sql: input.sql,
      sha: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each(reviewedFiles)("rejects modified reviewed bytes and path aliases for %s", async (file) => {
    const input = await source(file);
    const opts = { reviewedConstraints: true };
    expect(() => validateSqlSource({ ...input, sql: `${input.sql}\n` }, opts)).toThrow();
    expect(() => validateSqlSource({ ...input, file: "copied.sql" }, opts)).toThrow();
    expect(() => validateSqlSource({ ...input, realPath: resolve("elsewhere.sql") }, opts)).toThrow();
  });

  it.each([
    "ALTER TABLE jobs DROP CONSTRAINT jobs_check;",
    "ALTER TABLE IF EXISTS jobs DROP CONSTRAINT jobs_check;",
    "ALTER TABLE ONLY jobs DROP CONSTRAINT jobs_check;",
    "DROP TABLE jobs;",
    "ALTER TABLE jobs DROP COLUMN state;",
    "DROP INDEX jobs_idx;",
    "DROP FUNCTION do_work();",
    "DROP SCHEMA workflow_stage;",
    "TRUNCATE jobs;",
    "DELETE FROM jobs;",
  ])("keeps unreviewed destructive SQL blocked with opt-in: %s", (sql) => {
    expect(() => validateSqlSource({ file: "unreviewed.sql", sql, realPath: resolve("unreviewed.sql") }, {
      reviewedConstraints: true,
    })).toThrow();
  });
});

describe("offline-safe sidecar runner", () => {
  it("dry-runs the actual reviewed files without reading environment or constructing a client", async () => {
    const readEnvironment = vi.fn(() => { throw new Error("environment must stay unopened"); });
    const createClient = vi.fn(() => { throw new Error("database must stay unopened"); });
    const log = vi.fn();
    expect(await run(["--dry-run", "--reviewed-constraints", ...argv(...reviewedFiles)], {
      readSql: async (file: string) => {
        const { sql, realPath } = await source(file);
        return { sql, realPath };
      },
      readEnvironment, createClient, log, error: vi.fn(),
    })).toBe(0);
    expect(readEnvironment).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    const output = JSON.stringify(log.mock.calls);
    for (const file of reviewedFiles) expect(output).toContain(file);
    expect(output).toMatch(/sha256=[a-f0-9]{64}/);
  });

  it("validates every requested file before opening the environment or database", async () => {
    const { deps, client } = harness({ "first.sql": "CREATE TABLE first(id int);", "last.sql": "DROP TABLE jobs;" });
    expect(await run(argv("first.sql", "last.sql"), deps)).not.toBe(0);
    expect(deps.readSql).toHaveBeenCalledTimes(2);
    expect(deps.readEnvironment).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("commits each successful file and rolls back then stops on the first failure", async () => {
    const sql = { "one.sql": "CREATE TABLE one(id int);", "two.sql": "CREATE TABLE two(id int);", "three.sql": "CREATE TABLE three(id int);" };
    const { deps, client } = harness(sql, sql["two.sql"]);
    expect(await run(argv(...Object.keys(sql)), deps)).not.toBe(0);
    expect(client.query.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN", sql["one.sql"], "COMMIT", "BEGIN", sql["two.sql"], "ROLLBACK",
    ]);
    expect(client.end).toHaveBeenCalledOnce();
    const output = JSON.stringify([...deps.log.mock.calls, ...deps.error.mock.calls]);
    expect(output).not.toContain(url);
    expect(output).not.toContain("private-password");
    expect(output).not.toContain("provider leaked");
    expect(output).toContain("two.sql");
  });

  it("accepts supported TLS query options while preserving the endpoint", async () => {
    const { deps, client } = harness({ "safe.sql": "SELECT 1;" });
    const tlsUrl = `${url}?sslmode=require&channel_binding=require`;
    deps.readEnvironment.mockResolvedValue({ DATABASE_URL_UNPOOLED: tlsUrl });
    expect(await run(argv("safe.sql"), deps)).toBe(0);
    expect(deps.createClient).toHaveBeenCalledWith(tlsUrl);
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it.each([
    "host=other&port=6543",
    "hostaddr=127.0.0.1",
    "service=other-database",
    "connectionString=postgresql%3A%2F%2Fother%2Fdb",
  ])("rejects connection routing query overrides before constructing a client: %s", async (query) => {
    const { deps } = harness({ "safe.sql": "SELECT 1;" });
    deps.readEnvironment.mockResolvedValue({ DATABASE_URL_UNPOOLED: `${url}?${query}` });
    expect(await run(argv("safe.sql"), deps)).not.toBe(0);
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(JSON.stringify(deps.error.mock.calls)).not.toContain("private-password");
  });

  it("reports an unknown outcome after failed COMMIT even when rollback succeeds, and stops", async () => {
    const sql = { "one.sql": "CREATE TABLE one(id int);", "next.sql": "CREATE TABLE next(id int);" };
    const { deps, client } = harness(sql, "COMMIT");
    expect(await run(argv(...Object.keys(sql)), deps)).not.toBe(0);
    expect(client.query.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN", sql["one.sql"], "COMMIT", "ROLLBACK",
    ]);
    expect(client.end).toHaveBeenCalledOnce();
    const errors = JSON.stringify(deps.error.mock.calls);
    expect(errors).toMatch(/unknown|not confirmed/i);
    expect(errors).not.toMatch(/rolled back/i);
    expect(deps.log).not.toHaveBeenCalled();
    expect(errors).not.toContain("private-password");
    expect(errors).not.toContain("provider leaked");
  });

  it("rejects a pooler or wrong endpoint without constructing a database client", async () => {
    for (const badUrl of [url.replace(expected, `${expected}-pooler`), url.replace(expected, "ep-other")]) {
      const { deps } = harness({ "safe.sql": "SELECT 1;" });
      deps.readEnvironment.mockResolvedValue({ DATABASE_URL_UNPOOLED: badUrl });
      expect(await run(argv("safe.sql"), deps)).not.toBe(0);
      expect(deps.createClient).not.toHaveBeenCalled();
      expect(JSON.stringify(deps.error.mock.calls)).not.toContain("private-password");
    }
  });
});
