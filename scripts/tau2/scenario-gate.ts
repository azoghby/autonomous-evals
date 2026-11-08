/**
 * Deterministic, LLM-free acceptance gate for tau2 retail scenarios (replaces the LLM oracle):
 *  (a) replay the gold write actions through the REAL tool bindings on the seeded world -> every state assertion passes
 *  (b) on the untouched seed a null agent fails (a critical state assertion fails, or the scenario needs outputs/refusal a silent agent never gives)
 *  (c) a mutation of the replayed end state flips at least one assertion
 * Everything runs inside one transaction that is rolled back, so one seeded database serves every scenario.
 */
import type { PGlite } from "@electric-sql/pglite";
import { compileNamedParams } from "../../packages/core/src/sandbox/runtime/sql-text";
import type { SandboxScenario, ToolSpec } from "../../packages/core/src/sandbox/spec";
import type { GoldAction } from "./convert-retail";

export const WRITE_TOOLS = ["cancel_pending_order", "modify_pending_order_address", "modify_pending_order_payment", "modify_pending_order_items", "modify_user_address", "return_delivered_order_items", "exchange_delivered_order_items"] as const;

export interface GateResult { ok: boolean; reasons: string[] }

async function runTool(db: PGlite, tools: Map<string, ToolSpec>, a: GoldAction): Promise<Record<string, unknown> | null> {
  const b = tools.get(a.name)?.binding;
  if (!b || b.kind !== "sql") throw new Error(`tool ${a.name} has no SQL binding`);
  let last: Array<Record<string, unknown>> = [];
  for (const stmt of b.statements) {
    const { text, values } = compileNamedParams(stmt, a.arguments);
    last = (await db.query(text, values as unknown[])).rows as Array<Record<string, unknown>>;
  }
  return last[0] ?? null;
}

async function failing(db: PGlite, s: SandboxScenario): Promise<string[]> {
  const bad: string[] = [];
  for (const a of s.stateAssertions) {
    const rows = (await db.query(a.sql)).rows as Array<{ ok?: unknown }>;
    if (rows.length !== 1 || rows[0]!.ok !== true) bad.push(a.id);
  }
  return bad;
}

/** SQL that undoes the "main" effect of the gold run, used as the mutation. */
async function mutate(db: PGlite, s: SandboxScenario, gold: GoldAction[]): Promise<string> {
  const w = gold.find((g) => (WRITE_TOOLS as readonly string[]).includes(g.name));
  if (w && typeof w.arguments.order_id === "string") {
    await db.query("UPDATE orders SET status = CASE WHEN status = 'cancelled' THEN 'pending' ELSE 'delivered' END WHERE id = $1", [w.arguments.order_id]);
    return `revert status of ${w.arguments.order_id}`;
  }
  if (w && typeof w.arguments.user_id === "string") {
    await db.query("UPDATE users SET address1 = address1 || ' (reverted)' WHERE id = $1", [w.arguments.user_id]);
    return `revert address of ${w.arguments.user_id}`;
  }
  // No-write scenario: any stray write to the user's orders must trip the collateral assertion.
  const target = (await db.query("SELECT id FROM orders WHERE id = ANY($1) ORDER BY id LIMIT 1", [orderIdsOf(s)])).rows[0] as { id: string } | undefined;
  if (!target) throw new Error("no order to mutate");
  await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status <> 'cancelled'", [target.id]);
  return `stray cancel of ${target.id}`;
}

function orderIdsOf(s: SandboxScenario): string[] {
  const ids = new Set<string>();
  for (const a of s.stateAssertions) for (const m of a.sql.matchAll(/#W\d+/g)) ids.add(m[0]);
  return [...ids];
}

export async function gateScenario(db: PGlite, tools: Map<string, ToolSpec>, scenario: SandboxScenario, gold: GoldAction[]): Promise<GateResult> {
  const reasons: string[] = [];
  const writes = gold.filter((g) => (WRITE_TOOLS as readonly string[]).includes(g.name));
  const critical = scenario.stateAssertions.filter((a) => a.severity === "critical");

  // (b) untouched seed
  const nullFails = (await failing(db, scenario)).filter((id) => critical.some((c) => c.id === id));
  if (writes.length > 0 && nullFails.length === 0) reasons.push("null agent passes every critical assertion on the untouched seed");
  if (writes.length === 0 && scenario.requiredOutputs.length === 0 && !scenario.expectRefusal) reasons.push("no-write scenario has neither requiredOutputs nor expectRefusal, so a silent agent would pass");
  if (writes.length === 0 && (await failing(db, scenario)).length > 0) reasons.push("state assertions fail on the untouched seed of a no-write scenario");

  // (a) + (c), rolled back
  await db.exec("BEGIN");
  try {
    for (const g of writes) {
      const res = await runTool(db, tools, g);
      if (res === null) { reasons.push(`gold action ${g.name} ${JSON.stringify(g.arguments).slice(0, 120)} was a no-op/error in the sandbox`); break; }
    }
    if (reasons.length === 0) {
      const bad = await failing(db, scenario);
      if (bad.length > 0) reasons.push(`replay of gold actions fails assertions: ${bad.join(", ")}`);
      else {
        const what = await mutate(db, scenario, gold);
        if ((await failing(db, scenario)).length === 0) reasons.push(`mutation (${what}) did not flip any assertion`);
      }
    }
  } catch (e) {
    reasons.push(`replay error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await db.exec("ROLLBACK");
  }
  return { ok: reasons.length === 0, reasons };
}
