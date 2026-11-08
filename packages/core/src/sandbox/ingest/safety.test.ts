import { describe, expect, it } from "vitest";
import { assertSafeDdl, assertSafeSql, compileNamed, namedParams } from "./safety";

describe("namedParams", () => {
  it("returns distinct params in first-appearance order", () => {
    expect(namedParams("SELECT * FROM t WHERE a = :b AND c = :a AND d = :b")).toEqual(["b", "a"]);
  });
  it("ignores ::casts, literals and comments", () => {
    const sql = "SELECT :x::int, '12:30 :nope', \"c:ol\" -- :c1\n /* :c2 */ FROM t WHERE y = :y::text";
    expect(namedParams(sql)).toEqual(["x", "y"]);
  });
});

describe("compileNamed", () => {
  it("rewrites to positional params, reusing indexes", () => {
    const r = compileNamed("SELECT :a, :b, :a::int, ':lit'", { a: 1, b: "x" });
    expect(r.text).toBe("SELECT $1, $2, $1::int, ':lit'");
    expect(r.values).toEqual([1, "x"]);
  });
  it("binds null for missing args", () => {
    expect(compileNamed("SELECT :a, :b", { a: 1 })).toEqual({ text: "SELECT $1, $2", values: [1, null] });
  });
});

describe("assertSafeSql", () => {
  it.each([
    "SELECT * FROM orders WHERE id = :id LIMIT 1",
    "SELECT * FROM orders WHERE id = :id;",
    "-- lead\nWITH x AS (SELECT 1) SELECT * FROM x",
    "INSERT INTO t (a) VALUES (:a) ON CONFLICT (a) DO UPDATE SET a = EXCLUDED.a RETURNING *",
    "UPDATE tickets SET status = :s, updated_at = sandbox_now() WHERE id = :id RETURNING *",
    "DELETE FROM t WHERE id = :id",
    "SELECT 'DROP TABLE x; pg_read_file' AS note, created_at FROM t",
    "SELECT 1 /* harmless */",
    "UPDATE users SET role = :r WHERE id = :id",
  ])("accepts %s", (sql) => {
    expect(() => assertSafeSql(sql)).not.toThrow();
  });

  it.each([
    ["SELECT 1; DROP TABLE x", /multiple statements/],
    ["COPY t TO '/tmp/x'", /must start with|COPY/],
    ["SELECT 1 WHERE EXISTS (SELECT 1) AND true; GRANT ALL ON t TO u", /multiple statements/],
    ["WITH x AS (SELECT 1) SELECT * FROM x, (SELECT 1) y WHERE 1=1 AND (SELECT 1 FROM pg_roles)", /pg_/],
    ["ALTER TABLE t ADD COLUMN c int", /must start with/],
    ["CREATE EXTENSION dblink", /must start with/],
    ["SELECT pg_read_file('/etc/passwd')", /pg_/],
    ["SELECT lo_import('/etc/passwd')", /large-object/],
    ["SELECT * FROM dblink('x','y')", /dblink/],
    ["DELETE FROM t", /without WHERE/],
    ["UPDATE t SET a = :a", /without WHERE/],
    ["SELECT * FROM t WHERE id = $1", /positional/],
    ["SELECT '${x}' FROM t", /interpolation/],
    ["SELECT {{id}} FROM t", /interpolation/],
    ["SELECT 1 /* x", /Unterminated/],
    ["SELECT 'abc", /Unterminated/],
    ["SELECT * INTO newt FROM t", /INTO/],
    ["WITH x AS (SELECT 1) SELECT 1 /* ok */ ; SET ROLE admin", /multiple statements/],
    ["WITH d AS (DROP TABLE x) SELECT 1", /DROP/],
    ["", /empty/],
  ])("rejects %s", (sql, re) => {
    expect(() => assertSafeSql(sql)).toThrow(re);
  });

  it("does not let comments split keywords or hide a chained statement", () => {
    expect(() => assertSafeSql("SELECT 1; /* a */ DROP TABLE x")).toThrow(/multiple/);
    expect(() => assertSafeSql("SELECT 1 -- ;\n; DROP TABLE x")).toThrow(/multiple/);
  });
});

describe("assertSafeDdl", () => {
  it("allows tables, indexes, sql functions and $$ bodies", () => {
    const ddl = `
      CREATE TABLE a (id integer PRIMARY KEY, note text DEFAULT 'COPY me; GRANT x');
      CREATE INDEX a_idx ON a(id);
      CREATE FUNCTION sandbox_now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT now() $$;
      INSERT INTO a VALUES (1, 'CREATE EXTENSION x') ON CONFLICT DO NOTHING;`;
    expect(() => assertSafeDdl(ddl)).not.toThrow();
  });
  it.each([
    "CREATE EXTENSION pgcrypto;",
    "COPY a FROM '/etc/passwd';",
    "GRANT ALL ON a TO public;",
    "REVOKE ALL ON a FROM public;",
    "CREATE ROLE evil;",
    "CREATE USER evil;",
    "ALTER ROLE x SUPERUSER;",
    "DROP DATABASE x;",
    "DROP SCHEMA public CASCADE;",
    "SELECT pg_read_file('/x');",
    "DO $$ BEGIN PERFORM 1; END $$;",
    "SET ROLE postgres;",
    "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT pg_sleep(1) $$;",
  ])("rejects %s", (sql) => {
    expect(() => assertSafeDdl(sql)).toThrow(/Unsafe DDL/);
  });
});
