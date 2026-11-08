import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { EnvironmentSpec, type ToolSpec } from "../spec";
import { compileNamedParams } from "../runtime/sql-text";
import { WORLD_PREAMBLE_SQL } from "../runtime/world-sql";
import { buildAdkCustomerService } from "./adk-customer-service";
import { createPgliteExec } from "./validate";

const envDir = resolve(fileURLToPath(import.meta.url), "../../../../../../data/envs/adk-customer-service");
const haveEnv = ["openapi.yaml", "schema.sql", "seed.sql", "policies.md", "workflows.json", "LICENSE", "NOTICE.md"].every((f) => existsSync(resolve(envDir, f)));

/** The 12 tools of customer_service/agent.py, in upstream order. */
const TOOLS = [
  "send_call_companion_link", "approve_discount", "sync_ask_for_approval", "update_salesforce_crm", "access_cart_information", "modify_cart",
  "get_product_recommendations", "check_product_availability", "schedule_planting_service", "get_available_planting_times", "send_care_instructions", "generate_qr_code",
];

describe.skipIf(!haveEnv)("buildAdkCustomerService", () => {
  let built: Awaited<ReturnType<typeof buildAdkCustomerService>>;
  beforeAll(async () => { built = await buildAdkCustomerService(createPgliteExec(new PGlite())); }, 120_000);

  it("builds a valid spec with exactly the agent's 12 tools, all bound to hinted SQL", () => {
    const { spec, report } = built;
    expect(EnvironmentSpec.safeParse(spec).success).toBe(true);
    expect(spec.id).toBe("adk_customer_service");
    expect(spec.tools.map((t) => t.name)).toEqual(TOOLS);
    for (const t of spec.tools) {
      expect(t.binding.kind, t.name).toBe("sql");
      expect(report.bindings[t.name]!.origin, t.name).toBe("hint");
    }
    expect(report.validation?.ok).toBe(true);
    expect(report.validation?.downgraded ?? []).toEqual([]);
    expect(report.warnings.filter((w) => /rejected|failed|downgraded/i.test(w))).toEqual([]);
  });

  it("effects: sends are external, cart/discount/appointment/crm/qr are writes, lookups are reads", () => {
    const eff = Object.fromEntries(built.spec.tools.map((t) => [t.name, t.effect]));
    expect(eff).toMatchObject({
      send_call_companion_link: "external", send_care_instructions: "external",
      approve_discount: "write", sync_ask_for_approval: "write", update_salesforce_crm: "write", modify_cart: "write", schedule_planting_service: "write", generate_qr_code: "write",
      access_cart_information: "read", get_product_recommendations: "read", check_product_availability: "read", get_available_planting_times: "read",
    });
  });

  it("policies parse into numbered clauses that the workflows reference", () => {
    const ids = new Set(built.spec.policies[0]!.clauses.map((c) => c.id));
    expect(ids.size).toBeGreaterThanOrEqual(30);
    for (const wf of built.spec.workflows) {
      for (const ref of wf.policyRefs) expect(ids.has(ref), `${wf.id}:${ref}`).toBe(true);
      for (const t of wf.tools) expect(TOOLS).toContain(t);
    }
  });
});

/* ---- behavioural checks: the real bindings against the seeded world ---- */

describe.skipIf(!haveEnv)("adk-customer-service tool semantics", () => {
  let db: PGlite;
  let tools: Map<string, ToolSpec>;

  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const b = tools.get(name)!.binding;
    if (b.kind !== "sql") throw new Error("not sql");
    await db.exec("BEGIN");
    try {
      let last: Array<Record<string, unknown>> = [];
      for (const stmt of b.statements) {
        const { text, values } = compileNamedParams(stmt, args);
        last = (await db.query(text, values as unknown[])).rows as Array<Record<string, unknown>>;
      }
      await db.exec("COMMIT");
      return last[0]?._return;
    } catch (e) {
      await db.exec("ROLLBACK");
      throw e;
    }
  }
  const cart = async (): Promise<Record<string, number>> =>
    Object.fromEntries(((await db.query("SELECT product_id, quantity FROM cart_items WHERE customer_id = '123'")).rows as Array<{ product_id: string; quantity: number }>).map((r) => [r.product_id, r.quantity]));

  beforeAll(async () => {
    const { spec } = await buildAdkCustomerService();
    tools = new Map(spec.tools.map((t) => [t.name, t]));
    db = new PGlite();
    await db.exec(WORLD_PREAMBLE_SQL);
    await db.exec(`INSERT INTO sandbox_clock (id, frozen_now) VALUES (1, '${spec.state.frozenNow}')`);
    await db.exec(spec.state.ddl);
    await db.exec(spec.state.seedSql);
  }, 120_000);

  it("cart and recommendations match the upstream mocks", async () => {
    expect(await call("access_cart_information", { customer_id: "123" })).toEqual({
      items: [{ product_id: "soil-123", name: "Standard Potting Soil", quantity: 1 }, { product_id: "fert-456", name: "General Purpose Fertilizer", quantity: 1 }],
      subtotal: 25.98,
    });
    const rec = (await call("get_product_recommendations", { plant_type: "Petunias", customer_id: "123" })) as { recommendations: Array<{ product_id: string }> };
    expect(rec.recommendations.map((r) => r.product_id)).toEqual(["soil-456", "fert-789"]);
    const other = (await call("get_product_recommendations", { plant_type: "roses", customer_id: "123" })) as { recommendations: Array<{ product_id: string }> };
    expect(other.recommendations.map((r) => r.product_id)).toEqual(["soil-123", "fert-456"]);
    expect(await call("check_product_availability", { product_id: "soil-456", store_id: "pickup" })).toEqual({ available: true, quantity: 10, store: "pickup" });
    expect(await call("check_product_availability", { product_id: "soil-456", store_id: "Anytown Garden Store" })).toMatchObject({ available: true });
    expect(await call("check_product_availability", { product_id: "soil-456", store_id: "nowhere" })).toMatchObject({ available: false, quantity: 0 });
  });

  it("modify_cart adds, removes (ids or dicts) and ignores unknown products", async () => {
    const r = await call("modify_cart", { customer_id: "123", items_to_add: [{ product_id: "soil-456", quantity: 2 }, { product_id: "nope-1", quantity: 1 }], items_to_remove: ["soil-123"] });
    expect(r).toEqual({ status: "success", message: "Cart updated successfully.", items_added: true, items_removed: true });
    expect(await cart()).toEqual({ "fert-456": 1, "soil-456": 2 });
    await call("modify_cart", { customer_id: "123", items_to_add: [], items_to_remove: [{ product_id: "soil-456", quantity: 1 }] });
    expect(await cart()).toEqual({ "fert-456": 1, "soil-456": 1 });
    expect(await call("modify_cart", { customer_id: "123", items_to_add: [{ product_id: "nope-1", quantity: 1 }], items_to_remove: [] })).toMatchObject({ items_added: false, items_removed: false });
    await call("modify_cart", { customer_id: "123", items_to_add: [{ product_id: "soil-123", quantity: 1 }], items_to_remove: ["soil-456"] });
    expect(await cart()).toEqual({ "fert-456": 1, "soil-123": 1 });
  });

  it("planting slots: a booked slot is unavailable and cannot be double-booked", async () => {
    expect(await call("get_available_planting_times", { date: "2024-07-29" })).toEqual(["9-12", "13-16"]);
    expect(await call("get_available_planting_times", { date: "2024-07-27" })).toEqual(["13-16"]);
    expect(await call("schedule_planting_service", { customer_id: "123", date: "2024-07-27", time_range: "9-12", details: "Planting Petunias" })).toMatchObject({ status: "error" });
    const ok = await call("schedule_planting_service", { customer_id: "123", date: "2024-07-27", time_range: "1:00 PM - 4:00 PM", details: "Planting Petunias" });
    expect(ok).toMatchObject({ status: "success", date: "2024-07-27", time: "13-16", confirmation_time: "2024-07-27 13:00" });
    expect(await call("get_available_planting_times", { date: "2024-07-27" })).toEqual([]);
    await db.exec("DELETE FROM appointments WHERE customer_id = '123'");
  });

  it("discount limits: auto-approval up to 10, manager above; QR guardrails verbatim", async () => {
    expect(await call("approve_discount", { discount_type: "percentage", value: 15, reason: "price match" })).toEqual({ status: "rejected", message: "discount too large. Must be 10 or less." });
    expect(await call("approve_discount", { discount_type: "percentage", value: 10, reason: "loyalty" })).toEqual({ status: "ok" });
    expect(await call("sync_ask_for_approval", { discount_type: "percentage", value: 15, reason: "price match" })).toEqual({ status: "approved" });
    const rows = (await db.query("SELECT channel, value::float AS value, status, applied FROM discount_requests ORDER BY id")).rows;
    expect(rows).toEqual([
      { channel: "auto", value: 15, status: "rejected", applied: false },
      { channel: "auto", value: 10, status: "ok", applied: true },
      { channel: "manager", value: 15, status: "approved", applied: true },
    ]);
    expect(await call("generate_qr_code", { customer_id: "123", discount_value: 25, discount_type: "percentage", expiration_days: 30 })).toBe("cannot generate a QR code for this amount, must be 10% or less");
    expect(await call("generate_qr_code", { customer_id: "123", discount_value: 10, discount_type: "percentage", expiration_days: 30 })).toMatchObject({ status: "success", expiration_date: "2024-08-21" });
  });

  it("sends land in outbound_messages; crm updates are recorded", async () => {
    expect(await call("send_care_instructions", { customer_id: "123", plant_type: "Petunias", delivery_method: "email" })).toEqual({ status: "success", message: "Care instructions for Petunias sent via email." });
    expect(await call("send_call_companion_link", { phone_number: "+1-702-555-1212" })).toEqual({ status: "success", message: "Link sent to +1-702-555-1212" });
    expect(await call("update_salesforce_crm", { customer_id: "123", details: { services: "Planting" } })).toEqual({ status: "success", message: "Salesforce record updated." });
    const sent = (await db.query("SELECT kind, destination FROM outbound_messages ORDER BY id")).rows;
    expect(sent).toEqual([{ kind: "care_instructions", destination: "alex.johnson@example.com" }, { kind: "call_companion_link", destination: "+1-702-555-1212" }]);
  });
});
