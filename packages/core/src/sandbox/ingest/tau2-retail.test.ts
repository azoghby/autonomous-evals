import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { EnvironmentSpec, type ToolSpec } from "../spec";
import { compileNamedParams } from "../runtime/sql-text";
import { WORLD_PREAMBLE_SQL } from "../runtime/world-sql";
import { buildTau2Retail } from "./tau2-retail";
import { createPgliteExec } from "./validate";

const envDir = resolve(fileURLToPath(import.meta.url), "../../../../../../data/envs/tau2-retail");
const haveEnv = ["openapi.yaml", "schema.sql", "seed.sql", "policies.md", "workflows.json", "LICENSE", "NOTICE.md"].every((f) => existsSync(resolve(envDir, f)));

const TOOLS = [
  "find_user_id_by_email", "find_user_id_by_name_zip", "get_user_details", "get_order_details", "get_product_details", "list_all_product_types",
  "cancel_pending_order", "modify_pending_order_address", "modify_pending_order_payment", "modify_pending_order_items", "modify_user_address",
  "return_delivered_order_items", "exchange_delivered_order_items", "calculate", "transfer_to_human_agents",
];
const WRITES = ["cancel_pending_order", "modify_pending_order_address", "modify_pending_order_payment", "modify_pending_order_items", "modify_user_address", "return_delivered_order_items", "exchange_delivered_order_items"];

describe.skipIf(!haveEnv)("buildTau2Retail", () => {
  let built: Awaited<ReturnType<typeof buildTau2Retail>>;
  beforeAll(async () => { built = await buildTau2Retail(createPgliteExec(new PGlite())); }, 120_000);

  it("builds a valid spec with all 15 tools", () => {
    const { spec } = built;
    expect(EnvironmentSpec.safeParse(spec).success).toBe(true);
    expect(spec.id).toBe("tau2_retail");
    expect(spec.state.frozenNow).toBe("2025-01-01T12:00:00Z");
    expect(spec.tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
  });

  it("write tools have effect write; reads are read; transfer is external", () => {
    const eff = Object.fromEntries(built.spec.tools.map((t) => [t.name, t.effect]));
    for (const w of WRITES) expect(eff[w]).toBe("write");
    for (const r of ["find_user_id_by_email", "find_user_id_by_name_zip", "get_user_details", "get_order_details", "get_product_details", "list_all_product_types", "calculate"]) expect(eff[r]).toBe("read");
    expect(eff.transfer_to_human_agents).toBe("external");
  });

  it("binds every SQL-bindable tool to hinted SQL; only calculate is simulated; nothing downgraded", () => {
    const by = Object.fromEntries(built.spec.tools.map((t) => [t.name, t.binding]));
    for (const n of TOOLS.filter((t) => t !== "calculate")) {
      expect(by[n]!.kind, n).toBe("sql");
      expect(built.report.bindings[n]!.origin, n).toBe("hint");
    }
    expect(by.calculate!.kind).toBe("simulated");
    expect(built.report.validation?.ok).toBe(true);
    expect(built.report.validation?.downgraded.map((t) => t.name) ?? []).toEqual([]);
  });

  it("schema defines no sandbox_* objects", () => {
    const ddl = built.spec.state.ddl;
    expect(ddl).not.toMatch(/create\s+(or\s+replace\s+)?(table|function|view|index)[^;]*sandbox_/i);
    expect(built.spec.state.reportTables.some((t) => t.startsWith("sandbox_"))).toBe(false);
    expect(built.spec.state.reportTables).toEqual(expect.arrayContaining(["users", "orders", "order_items", "order_payments", "products", "product_variants", "user_payment_methods"]));
  });

  it("parses policies into >= 10 clauses and workflows reference existing clauses", () => {
    const clauses = built.spec.policies[0]!.clauses;
    expect(clauses.length).toBeGreaterThanOrEqual(10);
    const ids = new Set(clauses.map((c) => c.id));
    for (const wf of built.spec.workflows) for (const ref of wf.policyRefs) expect(ids.has(ref), `${wf.id}:${ref}`).toBe(true);
    expect(built.spec.workflows.length).toBeGreaterThanOrEqual(4);
    for (const wf of built.spec.workflows) for (const t of wf.tools) expect(TOOLS).toContain(t);
  });

  it("report warnings are only the expected dry-run notes (no rejected hints, no failed dry-runs)", () => {
    expect(built.report.warnings.filter((w) => /rejected|failed|downgraded/i.test(w))).toEqual([]);
    expect(built.report.warnings.every((w) => /dry-run returned zero rows/.test(w))).toBe(true);
  });
});

/* ---- behavioural checks: run the real bindings against the seeded world ---- */

describe.skipIf(!haveEnv)("tau2-retail tool semantics", () => {
  let db: PGlite;
  let tools: Map<string, ToolSpec>;

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any> | null> {
    const b = tools.get(name)!.binding;
    if (b.kind !== "sql") throw new Error("not sql");
    await db.exec("BEGIN");
    try {
      let last: Array<Record<string, any>> = [];
      for (const stmt of b.statements) {
        const { text, values } = compileNamedParams(stmt, args);
        last = (await db.query(text, values as unknown[])).rows as Array<Record<string, any>>;
      }
      await db.exec("COMMIT");
      return last[0] ?? null;
    } catch (e) {
      await db.exec("ROLLBACK");
      throw e;
    }
  }
  const one = async (sql: string, params: unknown[] = []): Promise<any> => (await db.query(sql, params)).rows[0];

  beforeAll(async () => {
    const { spec } = await buildTau2Retail();
    tools = new Map(spec.tools.map((t) => [t.name, t]));
    db = new PGlite();
    await db.exec(WORLD_PREAMBLE_SQL);
    await db.exec(`INSERT INTO sandbox_clock (id, frozen_now) VALUES (1, '${spec.state.frozenNow}')`);
    await db.exec(spec.state.ddl);
    await db.exec(spec.state.seedSql);
  }, 120_000);

  it("lookups return upstream-shaped data", async () => {
    const u = await one("SELECT id, email, first_name, last_name, zip FROM users ORDER BY id LIMIT 1");
    expect(await call("find_user_id_by_email", { email: u.email.toUpperCase() })).toEqual({ user_id: u.id });
    expect(await call("find_user_id_by_name_zip", { first_name: u.first_name, last_name: u.last_name, zip: u.zip })).toEqual({ user_id: u.id });
    expect(await call("find_user_id_by_email", { email: "nobody@example.com" })).toBeNull();
    const det = (await call("get_user_details", { user_id: u.id }))!;
    expect(det.user_id).toBe(u.id);
    expect(Object.keys(det.payment_methods).length).toBeGreaterThan(0);
    expect(det.orders.length).toBeGreaterThan(0);
    const types = (await call("list_all_product_types", {}))!.product_types;
    expect(Object.keys(types)).toHaveLength(50);
    const pid = Object.values(types)[0] as string;
    const prod = (await call("get_product_details", { product_id: pid }))!;
    expect(Object.keys(prod.variants).length).toBeGreaterThan(0);
  });

  it("cancel_pending_order refunds and rejects non-pending orders without changing state", async () => {
    const o = await one("SELECT o.id, o.user_id FROM orders o WHERE o.status = 'pending' ORDER BY o.id LIMIT 1");
    expect(await call("cancel_pending_order", { order_id: o.id, reason: "just because" })).toBeNull();
    expect((await one("SELECT status FROM orders WHERE id = $1", [o.id])).status).toBe("pending");
    const before = (await one("SELECT count(*)::int AS n FROM order_payments WHERE order_id = $1", [o.id])).n;
    const res = (await call("cancel_pending_order", { order_id: o.id, reason: "no longer needed" }))!;
    expect(res.status).toBe("cancelled");
    expect(res.cancel_reason).toBe("no longer needed");
    expect(res.payment_history).toHaveLength(before * 2);
    expect(res.payment_history.at(-1).transaction_type).toBe("refund");
    expect(await call("cancel_pending_order", { order_id: o.id, reason: "no longer needed" })).toBeNull();
    const del = await one("SELECT id FROM orders WHERE status = 'delivered' LIMIT 1");
    expect(await call("cancel_pending_order", { order_id: del.id, reason: "no longer needed" })).toBeNull();
  });

  it("modify_pending_order_address only touches pending orders", async () => {
    const p = await one("SELECT id FROM orders WHERE status = 'pending' ORDER BY id DESC LIMIT 1");
    const addr = { address1: "1 Test St", address2: "Apt 2", city: "Testville", state: "CA", country: "USA", zip: "94000" };
    const res = (await call("modify_pending_order_address", { order_id: p.id, ...addr }))!;
    expect(res.address).toEqual(addr);
    const d = await one("SELECT id FROM orders WHERE status = 'delivered' LIMIT 1");
    expect(await call("modify_pending_order_address", { order_id: d.id, ...addr })).toBeNull();
  });

  it("modify_pending_order_items swaps to a same-product variant once and rejects a second call", async () => {
    const row = await one(`SELECT o.id AS order_id, i.item_id AS old_id, i.price AS old_price, v.item_id AS new_id, v.price AS new_price, pm.id AS pm
      FROM orders o JOIN order_items i ON i.order_id = o.id
      JOIN product_variants v ON v.product_id = i.product_id AND v.item_id <> i.item_id AND v.available
      JOIN user_payment_methods pm ON pm.user_id = o.user_id AND pm.source <> 'gift_card'
      WHERE o.status = 'pending' ORDER BY o.id, i.id, v.item_id LIMIT 1`);
    const args = { order_id: row.order_id, item_ids: [row.old_id], new_item_ids: [row.new_id], payment_method_id: row.pm };
    expect(await call("modify_pending_order_items", { ...args, new_item_ids: [row.old_id] })).toBeNull();
    const res = (await call("modify_pending_order_items", args))!;
    expect(res.status).toBe("pending (item modified)");
    expect(res.items.some((i: any) => i.item_id === row.new_id && Number(i.price) === Number(row.new_price))).toBe(true);
    const diff = Math.round((Number(row.new_price) - Number(row.old_price)) * 100) / 100;
    const last = res.payment_history.at(-1);
    expect(last.transaction_type).toBe(diff > 0 ? "payment" : "refund");
    expect(Number(last.amount)).toBeCloseTo(Math.abs(diff), 2);
    expect(await call("modify_pending_order_items", args)).toBeNull();
  });

  it("return / exchange require delivered status and enforce the refund method rule", async () => {
    const row = await one(`SELECT o.id AS order_id, i.item_id, i.product_id, o.user_id,
        (SELECT p.payment_method_id FROM order_payments p WHERE p.order_id = o.id ORDER BY p.id LIMIT 1) AS orig_pm
      FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.status = 'delivered' ORDER BY o.id, i.id LIMIT 1`);
    const other = await one("SELECT id FROM user_payment_methods WHERE user_id = $1 AND source <> 'gift_card' AND id <> $2 LIMIT 1", [row.user_id, row.orig_pm]);
    if (other) expect(await call("return_delivered_order_items", { order_id: row.order_id, item_ids: [row.item_id], payment_method_id: other.id })).toBeNull();
    expect(await call("return_delivered_order_items", { order_id: row.order_id, item_ids: ["0000000000"], payment_method_id: row.orig_pm })).toBeNull();
    const ret = (await call("return_delivered_order_items", { order_id: row.order_id, item_ids: [row.item_id], payment_method_id: row.orig_pm }))!;
    expect(ret.status).toBe("return requested");
    expect(ret.return_items).toEqual([row.item_id]);
    expect(await call("return_delivered_order_items", { order_id: row.order_id, item_ids: [row.item_id], payment_method_id: row.orig_pm })).toBeNull();

    const ex = await one(`SELECT o.id AS order_id, i.item_id AS old_id, v.item_id AS new_id, (SELECT p.payment_method_id FROM order_payments p WHERE p.order_id = o.id ORDER BY p.id LIMIT 1) AS pm
      FROM orders o JOIN order_items i ON i.order_id = o.id JOIN product_variants v ON v.product_id = i.product_id AND v.item_id <> i.item_id AND v.available
      WHERE o.status = 'delivered' ORDER BY o.id, i.id, v.item_id LIMIT 1`);
    const exRes = (await call("exchange_delivered_order_items", { order_id: ex.order_id, item_ids: [ex.old_id], new_item_ids: [ex.new_id], payment_method_id: ex.pm }))!;
    expect(exRes.status).toBe("exchange requested");
    expect(exRes.exchange_items).toEqual([ex.old_id]);
    expect(exRes.exchange_new_items).toEqual([ex.new_id]);
    expect(exRes.exchange_price_difference).not.toBeNull();
  });

  it("modify_pending_order_payment moves the payment and rejects the same method", async () => {
    const row = await one(`SELECT o.id AS order_id, p.payment_method_id AS old_pm, pm.id AS new_pm
      FROM orders o JOIN order_payments p ON p.order_id = o.id JOIN user_payment_methods pm ON pm.user_id = o.user_id AND pm.id <> p.payment_method_id AND pm.source <> 'gift_card'
      WHERE o.status = 'pending' AND (SELECT count(*) FROM order_payments x WHERE x.order_id = o.id) = 1 ORDER BY o.id LIMIT 1`);
    expect(row).toBeTruthy();
    expect(await call("modify_pending_order_payment", { order_id: row.order_id, payment_method_id: row.old_pm })).toBeNull();
    const res = (await call("modify_pending_order_payment", { order_id: row.order_id, payment_method_id: row.new_pm }))!;
    expect(res.status).toBe("pending");
    expect(res.payment_history.map((p: any) => [p.transaction_type, p.payment_method_id])).toEqual([["payment", row.old_pm], ["payment", row.new_pm], ["refund", row.old_pm]]);
  });

  it("modify_user_address updates the profile; transfer_to_human_agents records to the outbox", async () => {
    const u = await one("SELECT id FROM users ORDER BY id LIMIT 1");
    const addr = { address1: "9 Elm St", address2: "", city: "Austin", state: "TX", country: "USA", zip: "73301" };
    const res = (await call("modify_user_address", { user_id: u.id, ...addr }))!;
    expect(res.address).toEqual(addr);
    expect(await call("modify_user_address", { user_id: "nobody_000", ...addr })).toBeNull();
    expect(await call("transfer_to_human_agents", { summary: "needs a human" })).toEqual({ result: "Transfer successful" });
    expect((await one("SELECT count(*)::int AS n FROM sandbox_outbox WHERE tool = 'transfer_to_human_agents'")).n).toBe(1);
  });
});
