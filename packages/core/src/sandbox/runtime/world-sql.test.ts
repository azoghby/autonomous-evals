import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { SqlConn } from "./types";
import { WORLD_PREAMBLE_SQL, clockSql, readDiff, readOutbox, refreshDiff, snapshotBaseline } from "./world-sql";

const FROZEN = "2030-01-02T03:04:05.000Z";

function adapt(db: PGlite): SqlConn {
  return {
    async query(sql, params) {
      const r = await db.query(sql, params as unknown[] | undefined);
      const rows = r.rows as never[];
      return { rows, rowCount: r.affectedRows ?? rows.length };
    },
    async exec(script) { await db.exec(script); },
    async close() { await db.close(); },
  };
}

describe("world-sql", () => {
  let db: PGlite;
  let conn: SqlConn;

  beforeEach(async () => {
    db = new PGlite();
    conn = adapt(db);
    await conn.exec(WORLD_PREAMBLE_SQL);
    const c = clockSql(FROZEN);
    await conn.query(c.text, c.values);
    await conn.exec(`
      CREATE TABLE customers (id int PRIMARY KEY, name text, created_at timestamptz DEFAULT sandbox_now());
      CREATE TABLE orders (customer_id int, order_no int, total numeric, PRIMARY KEY (customer_id, order_no));
      CREATE TABLE audit_log (msg text, n int);
      CREATE SCHEMA ext;
      CREATE TABLE ext.items (sku text PRIMARY KEY, qty int);
      INSERT INTO customers (id, name) VALUES (1,'Ann'),(2,'Bob'),(3,'Cy');
      INSERT INTO orders VALUES (1,1,10),(1,2,20),(2,1,30);
      INSERT INTO audit_log VALUES ('dup',1),('dup',1),('other',2);
      INSERT INTO ext.items VALUES ('a',1),('b',2);
    `);
    await snapshotBaseline(conn);
  });

  afterEach(async () => { await db.close(); });

  it("reports no changes right after the baseline", async () => {
    await refreshDiff(conn);
    expect(await readDiff(conn)).toEqual([]);
  });

  it("diffs inserts, updates, deletes across tables with exact counts and samples", async () => {
    await conn.exec(`
      INSERT INTO customers (id, name) VALUES (4,'Dee');
      UPDATE customers SET name = 'Robert' WHERE id = 2;
      UPDATE customers SET name = 'Ann' WHERE id = 1;           -- same value: not a change
      DELETE FROM customers WHERE id = 3;
      UPDATE orders SET total = 99 WHERE customer_id = 1 AND order_no = 2;
      DELETE FROM audit_log WHERE msg = 'dup' AND ctid = (SELECT min(ctid) FROM audit_log WHERE msg = 'dup');
      INSERT INTO ext.items VALUES ('c',3);
      INSERT INTO sandbox_outbox (tool, args, payload) VALUES ('send_email', '{"to":"x"}', '{"ok":true}');
    `);
    await refreshDiff(conn);
    const diff = await readDiff(conn);

    expect(diff.map((d) => d.table)).toEqual(["audit_log", "customers", "ext.items", "orders"]);
    const by = Object.fromEntries(diff.map((d) => [d.table, d]));

    expect(by["audit_log"]).toMatchObject({ inserted: 0, updated: 0, deleted: 1 });
    expect(by["audit_log"].sample).toHaveLength(1);
    expect(by["audit_log"].sample[0]).toMatchObject({ change: "deleted", before: { msg: "dup", n: 1 }, after: null });

    expect(by["customers"]).toMatchObject({ inserted: 1, updated: 1, deleted: 1 });
    expect(by["customers"].sample.map((s) => [s.change, s.pk])).toEqual([
      ["deleted", { id: 3 }],
      ["inserted", { id: 4 }],
      ["updated", { id: 2 }],
    ]);
    const upd = by["customers"].sample[2] as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(upd.before.name).toBe("Bob");
    expect(upd.after.name).toBe("Robert");

    expect(by["ext.items"]).toMatchObject({ inserted: 1, updated: 0, deleted: 0 });
    expect(by["ext.items"].sample[0]).toMatchObject({ change: "inserted", pk: { sku: "c" }, before: null, after: { sku: "c", qty: 3 } });

    expect(by["orders"]).toMatchObject({ inserted: 0, updated: 1, deleted: 0 });
    expect(by["orders"].sample[0]).toMatchObject({ pk: { customer_id: 1, order_no: 2 }, change: "updated" });
    expect((by["orders"].sample[0] as { after: { total: number } }).after.total).toBe(99);
  });

  it("never includes sandbox_* tables and exposes outbox rows", async () => {
    await conn.query("INSERT INTO sandbox_outbox (tool, payload) VALUES ($1, $2)", ["send_email", { to: "a@b.c" }]);
    await refreshDiff(conn);
    expect(await readDiff(conn)).toEqual([]);
    const out = await readOutbox(conn);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tool: "send_email", payload: { to: "a@b.c" } });
    expect(new Date(out[0].created_at as string | Date).toISOString()).toBe(FROZEN);
  });

  it("limits samples to sampleSize but counts everything", async () => {
    await conn.exec("INSERT INTO customers (id, name) SELECT g, 'x' FROM generate_series(10, 19) g");
    await refreshDiff(conn);
    const [d] = await readDiff(conn, { sampleSize: 3 });
    expect(d.inserted).toBe(10);
    expect(d.sample).toHaveLength(3);
    const [dflt] = await readDiff(conn);
    expect(dflt.sample).toHaveLength(5);
  });

  it("sandbox_now() returns the frozen time and works as a column default", async () => {
    const r = await conn.query<{ n: string | Date }>("SELECT sandbox_now() AS n");
    expect(new Date(r.rows[0].n).toISOString()).toBe(FROZEN);
    await conn.exec("INSERT INTO customers (id, name) VALUES (50,'Zed')");
    const c = await conn.query<{ created_at: string | Date }>("SELECT created_at FROM customers WHERE id = 50");
    expect(new Date(c.rows[0].created_at).toISOString()).toBe(FROZEN);
  });

  it("clockSql upserts the single clock row", async () => {
    const c = clockSql("2031-05-05T00:00:00Z");
    await conn.query(c.text, c.values);
    const r = await conn.query<{ n: string | Date }>("SELECT sandbox_now() AS n");
    expect(new Date(r.rows[0].n).toISOString()).toBe("2031-05-05T00:00:00.000Z");
    const cnt = await conn.query<{ c: number }>("SELECT count(*)::int AS c FROM sandbox_clock");
    expect(cnt.rows[0].c).toBe(1);
  });

  it("refresh is idempotent and the summary view matches", async () => {
    await conn.exec("INSERT INTO customers (id, name) VALUES (9,'N'); DELETE FROM orders WHERE customer_id = 2;");
    await refreshDiff(conn);
    const first = await readDiff(conn);
    await refreshDiff(conn);
    expect(await readDiff(conn)).toEqual(first);
    const s = await conn.query<{ table_name: string; inserted: number; updated: number; deleted: number }>(
      "SELECT * FROM sandbox_diff_summary ORDER BY table_name",
    );
    expect(s.rows).toEqual([
      { table_name: "customers", inserted: 1, updated: 0, deleted: 0 },
      { table_name: "orders", inserted: 0, updated: 0, deleted: 1 },
    ]);
    expect(first.map((d) => [d.table, d.inserted, d.updated, d.deleted])).toEqual([
      ["customers", 1, 0, 0],
      ["orders", 0, 0, 1],
    ]);
  });

  it("marks all rows of a dropped table as deleted", async () => {
    await conn.exec("DROP TABLE audit_log");
    await refreshDiff(conn);
    const diff = await readDiff(conn);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ table: "audit_log", inserted: 0, updated: 0, deleted: 3 });
  });

  it("preamble is re-runnable", async () => {
    await conn.exec(WORLD_PREAMBLE_SQL);
    await refreshDiff(conn);
    expect(await readDiff(conn)).toEqual([]);
  });
});
