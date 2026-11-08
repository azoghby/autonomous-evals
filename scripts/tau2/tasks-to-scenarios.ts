/**
 * Converts REAL tau2-bench retail tasks into SandboxScenario objects (no LLM).
 *
 *   npx tsx scripts/tau2/tasks-to-scenarios.ts <path/to/db.json> <out.json> [--max N]
 *
 * tasks.json is read next to db.json. Assertions are derived deterministically from each task's gold
 * `evaluation_criteria.actions`: a small independent TypeScript model of tools.py (cents-exact) computes the
 * end state, and SQL `SELECT ... AS ok` checks pin it. The suite only contains scenarios that pass the
 * deterministic gate in scenario-gate.ts. Source: tau2-bench (MIT, Sierra Research).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { buildTau2Retail } from "../../packages/core/src/sandbox/ingest/tau2-retail";
import { SandboxScenario } from "../../packages/core/src/sandbox/spec";
import { actionUserIds, selectUsers, type Db, type GoldAction, type Order, type Task } from "./convert-retail";
import { gateScenario, WRITE_TOOLS } from "./scenario-gate";

export const SOURCE = "tau2-bench tasks.json @033bf08";
const SEED_USERS = 32;
const DEFAULT_MAX = 10;
const MAX_STATE_ASSERTIONS = 15;

/* ---------------- tiny SQL literal helpers ---------------- */

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const jb = (v: unknown): string => `${q(JSON.stringify(v))}::jsonb`;
const cents = (n: number): number => Math.round(n * 100);
const money = (c: number): number => c / 100;
const sameOrNull = (col: string, v: string | number | string[] | null): string =>
  v === null ? `${col} IS NULL` : Array.isArray(v) ? `${col} IS NOT DISTINCT FROM ${jb(v)}` : typeof v === "number" ? `${col} = ${v}` : `${col} = ${q(v)}`;

/* ---------------- independent model of tools.py (cents-exact) ---------------- */

interface MItem { product_id: string; item_id: string; price: number; options: Record<string, string> }
interface MPay { t: string; a: number; m: string }
interface MAddr { address1: string; address2: string; city: string; state: string; country: string; zip: string }
interface MOrder {
  id: string; user_id: string; address: MAddr; status: string; items: MItem[]; payments: MPay[];
  cancel_reason: string | null; exchange_items: string[] | null; exchange_new_items: string[] | null; exchange_pm: string | null; exchange_diff: number | null;
  return_items: string[] | null; return_pm: string | null;
}
interface World { orders: Map<string, MOrder>; userAddr: Map<string, MAddr>; balance: Map<string, number>; source: Map<string, string>; touchedPm: Set<string> }

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function toModel(o: Order): MOrder {
  return {
    id: o.order_id, user_id: o.user_id, address: clone(o.address), status: o.status,
    items: o.items.map((i) => ({ product_id: i.product_id, item_id: i.item_id, price: cents(i.price), options: clone(i.options) })),
    payments: o.payment_history.map((p) => ({ t: p.transaction_type, a: cents(p.amount), m: p.payment_method_id })),
    cancel_reason: o.cancel_reason ?? null, exchange_items: o.exchange_items ?? null, exchange_new_items: o.exchange_new_items ?? null,
    exchange_pm: o.exchange_payment_method_id ?? null, exchange_diff: o.exchange_price_difference == null ? null : cents(o.exchange_price_difference),
    return_items: o.return_items ?? null, return_pm: o.return_payment_method_id ?? null,
  };
}

function makeWorld(db: Db, userIds: string[]): World {
  const w: World = { orders: new Map(), userAddr: new Map(), balance: new Map(), source: new Map(), touchedPm: new Set() };
  for (const uid of userIds) {
    const u = db.users[uid]!;
    w.userAddr.set(uid, clone(u.address));
    for (const pm of Object.values(u.payment_methods)) {
      w.source.set(pm.id, pm.source);
      if (pm.source === "gift_card") w.balance.set(pm.id, cents(pm.balance ?? 0));
    }
    for (const oid of u.orders) w.orders.set(oid, toModel(db.orders[oid]!));
  }
  return w;
}

function must<T>(v: T | undefined | null, msg: string): T { if (v === undefined || v === null) throw new Error(msg); return v; }
const isGift = (w: World, pm: string): boolean => w.source.get(pm) === "gift_card";
const userOwnsPm = (db: Db, userId: string, pm: string): boolean => pm in db.users[userId]!.payment_methods;

function variantOf(db: Db, productId: string, itemId: string): { price: number; options: Record<string, string> } {
  const v = must(db.products[productId]?.variants[itemId], `variant ${productId}/${itemId} not found`);
  if (!v.available) throw new Error(`variant ${itemId} unavailable`);
  return { price: cents(v.price), options: clone(v.options) };
}

function containsAll(order: MOrder, ids: string[]): boolean {
  return ids.every((id) => ids.filter((x) => x === id).length <= order.items.filter((i) => i.item_id === id).length);
}

/** Applies one gold write action; throws when tools.py would raise ValueError. */
function apply(db: Db, w: World, a: GoldAction): void {
  const g = a.arguments;
  const ord = (): MOrder => must(w.orders.get(g.order_id as string), `order ${String(g.order_id)} not modelled`);
  switch (a.name) {
    case "cancel_pending_order": {
      const o = ord();
      if (o.status !== "pending") throw new Error("non-pending cancel");
      if (!["no longer needed", "ordered by mistake"].includes(g.reason as string)) throw new Error("bad reason");
      for (const p of [...o.payments]) {
        o.payments.push({ t: "refund", a: p.a, m: p.m });
        if (isGift(w, p.m)) { w.balance.set(p.m, w.balance.get(p.m)! + p.a); w.touchedPm.add(p.m); }
      }
      o.status = "cancelled"; o.cancel_reason = g.reason as string;
      return;
    }
    case "modify_pending_order_address": {
      const o = ord();
      if (!o.status.includes("pending")) throw new Error("non-pending address modify");
      o.address = { address1: g.address1 as string, address2: g.address2 as string, city: g.city as string, state: g.state as string, country: g.country as string, zip: g.zip as string };
      return;
    }
    case "modify_pending_order_payment": {
      const o = ord(); const pm = g.payment_method_id as string;
      if (!o.status.includes("pending")) throw new Error("non-pending payment modify");
      if (!userOwnsPm(db, o.user_id, pm)) throw new Error("pm not found");
      if (o.payments.length !== 1 || o.payments[0]!.t !== "payment") throw new Error("need exactly one payment");
      const old = o.payments[0]!; if (old.m === pm) throw new Error("same payment method");
      if (isGift(w, pm) && w.balance.get(pm)! < old.a) throw new Error("insufficient balance");
      o.payments.push({ t: "payment", a: old.a, m: pm }, { t: "refund", a: old.a, m: old.m });
      if (isGift(w, pm)) { w.balance.set(pm, w.balance.get(pm)! - old.a); w.touchedPm.add(pm); }
      if (isGift(w, old.m)) { w.balance.set(old.m, w.balance.get(old.m)! + old.a); w.touchedPm.add(old.m); }
      return;
    }
    case "modify_pending_order_items": {
      const o = ord(); const pm = g.payment_method_id as string;
      const oldIds = g.item_ids as string[]; const newIds = g.new_item_ids as string[];
      if (o.status !== "pending") throw new Error("non-pending items modify");
      if (oldIds.length !== newIds.length || !containsAll(o, oldIds)) throw new Error("item mismatch");
      if (!userOwnsPm(db, o.user_id, pm)) throw new Error("pm not found");
      const used = new Map<string, number>(); let diff = 0;
      const edits: Array<{ line: MItem; newId: string; v: { price: number; options: Record<string, string> } }> = [];
      oldIds.forEach((oldId, k) => {
        if (oldId === newIds[k]) throw new Error("same item");
        const occ = used.get(oldId) ?? 0; used.set(oldId, occ + 1);
        const line = must(o.items.filter((i) => i.item_id === oldId)[occ], "line not found");
        const v = variantOf(db, line.product_id, newIds[k]!);
        diff += v.price - line.price; edits.push({ line, newId: newIds[k]!, v });
      });
      if (isGift(w, pm) && w.balance.get(pm)! < diff) throw new Error("insufficient balance");
      o.payments.push({ t: diff > 0 ? "payment" : "refund", a: Math.abs(diff), m: pm });
      if (isGift(w, pm)) { w.balance.set(pm, w.balance.get(pm)! - diff); w.touchedPm.add(pm); }
      for (const e of edits) { e.line.item_id = e.newId; e.line.price = e.v.price; e.line.options = e.v.options; }
      o.status = "pending (item modified)";
      return;
    }
    case "return_delivered_order_items": {
      const o = ord(); const pm = g.payment_method_id as string; const ids = g.item_ids as string[];
      if (o.status !== "delivered") throw new Error("non-delivered return");
      if (!userOwnsPm(db, o.user_id, pm)) throw new Error("pm not found");
      if (!isGift(w, pm) && pm !== o.payments[0]!.m) throw new Error("refund must go to original method");
      if (!containsAll(o, ids)) throw new Error("item not found");
      o.status = "return requested"; o.return_items = [...ids].sort(); o.return_pm = pm;
      return;
    }
    case "exchange_delivered_order_items": {
      const o = ord(); const pm = g.payment_method_id as string;
      const oldIds = g.item_ids as string[]; const newIds = g.new_item_ids as string[];
      if (o.status !== "delivered") throw new Error("non-delivered exchange");
      if (!containsAll(o, oldIds) || oldIds.length !== newIds.length) throw new Error("item mismatch");
      let diff = 0;
      oldIds.forEach((oldId, k) => {
        const line = must(o.items.find((i) => i.item_id === oldId), "item not found");
        diff += variantOf(db, line.product_id, newIds[k]!).price - line.price;
      });
      if (!userOwnsPm(db, o.user_id, pm)) throw new Error("pm not found");
      if (isGift(w, pm) && w.balance.get(pm)! < diff) throw new Error("insufficient balance");
      o.status = "exchange requested"; o.exchange_items = [...oldIds].sort(); o.exchange_new_items = [...newIds].sort(); o.exchange_pm = pm; o.exchange_diff = diff;
      return;
    }
    case "modify_user_address": {
      const uid = g.user_id as string;
      if (!w.userAddr.has(uid)) throw new Error("user not found");
      w.userAddr.set(uid, { address1: g.address1 as string, address2: g.address2 as string, city: g.city as string, state: g.state as string, country: g.country as string, zip: g.zip as string });
      return;
    }
    default: throw new Error(`not a write tool: ${a.name}`);
  }
}

/* ---------------- assertions ---------------- */

type Assertion = SandboxScenario["stateAssertions"][number];
const wrap = (expr: string): string => `SELECT COALESCE((${expr}), false) AS ok`;
const addrExpr = (p: string, a: MAddr): string => (Object.keys(a) as Array<keyof MAddr>).map((k) => `${p}${k} = ${q(a[k])}`).join(" AND ");
const short = (id: string): string => id.replace("#", "");

function orderAssertions(o: MOrder, merged: boolean): Assertion[] {
  const fields = `SELECT (o.status = ${q(o.status)} AND ${sameOrNull("o.cancel_reason", o.cancel_reason)} AND ${sameOrNull("o.exchange_items", o.exchange_items)} AND ${sameOrNull("o.exchange_new_items", o.exchange_new_items)} AND ${sameOrNull("o.exchange_payment_method_id", o.exchange_pm)} AND ${sameOrNull("o.exchange_price_difference", o.exchange_diff === null ? null : money(o.exchange_diff))} AND ${sameOrNull("o.return_items", o.return_items)} AND ${sameOrNull("o.return_payment_method_id", o.return_pm)} AND ${addrExpr("o.", o.address)}) FROM orders o WHERE o.id = ${q(o.id)}`;
  const items = `SELECT COALESCE(jsonb_agg(jsonb_build_object('i', i.item_id, 'p', i.price, 'o', i.options) ORDER BY i.id), '[]'::jsonb) = ${jb(o.items.map((i) => ({ i: i.item_id, p: money(i.price), o: i.options })))} FROM order_items i WHERE i.order_id = ${q(o.id)}`;
  const pays = `SELECT COALESCE(jsonb_agg(jsonb_build_object('t', p.transaction_type, 'a', p.amount, 'm', p.payment_method_id) ORDER BY p.id), '[]'::jsonb) = ${jb(o.payments.map((p) => ({ t: p.t, a: money(p.a), m: p.m })))} FROM order_payments p WHERE p.order_id = ${q(o.id)}`;
  const d = (what: string): string => `Order ${o.id} ${what} (end state of the gold actions)`;
  if (merged) return [{ id: `o_${short(o.id)}`, description: d("has the exact expected status, fields, items and payment history"), sql: wrap(`${fields.replace("SELECT (", "SELECT ((")} ) AND (${items}) AND (${pays})`), severity: "critical" }];
  return [
    { id: `o_${short(o.id)}_state`, description: d(`has status '${o.status}' and the expected cancel/return/exchange fields and address`), sql: wrap(fields), severity: "critical" },
    { id: `o_${short(o.id)}_items`, description: d("has the expected line items (item ids, prices, options)"), sql: wrap(items), severity: "critical" },
    { id: `o_${short(o.id)}_pay`, description: d("has the expected payment/refund history"), sql: wrap(pays), severity: "critical" },
  ];
}

/* ---------------- task classification / persona ---------------- */

const FLOW: Record<string, string> = {
  cancel_pending_order: "cancel_pending_order", modify_pending_order_items: "modify_pending_order_items",
  modify_pending_order_address: "modify_pending_order_address_or_payment", modify_pending_order_payment: "modify_pending_order_address_or_payment",
  return_delivered_order_items: "return_delivered_items", exchange_delivered_order_items: "exchange_delivered_items", modify_user_address: "update_user_address",
};
const isWrite = (n: string): boolean => (WRITE_TOOLS as readonly string[]).includes(n);
const goldOf = (t: Task): GoldAction[] => (t.evaluation_criteria?.actions ?? []).map((a) => ({ name: a.name, arguments: a.arguments }));
const instr = (t: Task) => (typeof t.user_scenario?.instructions === "object" && t.user_scenario.instructions) || {};
const meaningful = (s?: string | null): string => (s && s.replace(/[.\s]/g, "") ? s.trim() : "");

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > n / 2 ? cut.slice(0, end + 1) : cut;
}

function personaFor(db: Db, t: Task, userId: string) {
  const i = instr(t);
  const u = db.users[userId]!;
  const goal = clip([meaningful(i.reason_for_call), meaningful(i.task_instructions)].filter(Boolean).join(" "), 1000);
  const facts = [...(meaningful(i.known_info).match(/[^.!?]+[.!?]*/g) ?? []), meaningful(i.unknown_info)].map((f) => f.trim()).filter(Boolean);
  return {
    name: `${u.name.first_name} ${u.name.last_name}`,
    goal,
    knowledge: facts.map((fact) => ({ fact: clip(fact, 500), revealWhen: "when_asked" as const })),
    style: "Natural, concise customer. Answers only what the agent asks. Declines to confirm actions the goal does not want.",
    adversarial: false, modality: "text" as const, maxTurns: 20,
  };
}

function workflowFor(t: Task, writes: GoldAction[]): string {
  if (writes.length > 0) return FLOW[writes[0]!.name]!;
  const text = meaningful(instr(t).reason_for_call).toLowerCase();
  const byKeyword: Array<[string, string]> = [["exchange", "exchange_delivered_order_items"], ["return", "return_delivered_order_items"], ["address", "modify_user_address"], ["cancel", "cancel_pending_order"]];
  const hit = byKeyword.find(([kw]) => text.includes(kw));
  return FLOW[hit ? hit[1] : "cancel_pending_order"]!;
}

export interface Converted { scenario: SandboxScenario; gold: GoldAction[]; kinds: string[] }

/** Builds the scenario for one task; throws (with a reason) when the task cannot be modelled. */
export function convertTask(db: Db, t: Task, seedUsers: Set<string>): Converted {
  const gold = goldOf(t);
  const users = [...new Set(gold.flatMap((a) => actionUserIds(db, a.arguments)))];
  if (users.length !== 1) throw new Error(`expected exactly one user, found ${users.length}`);
  const uid = users[0]!;
  if (!seedUsers.has(uid)) throw new Error(`user ${uid} not in seed subset`);
  const writes = gold.filter((a) => isWrite(a.name));
  const world = makeWorld(db, [uid]);
  const initial = makeWorld(db, [uid]);
  for (const a of writes) apply(db, world, a);

  const touched = [...new Set(writes.map((a) => a.arguments.order_id as string | undefined).filter((x): x is string => !!x))];
  const merged = touched.length * 3 + 1 + 1 + 1 > MAX_STATE_ASSERTIONS;
  const stateAssertions: Assertion[] = touched.flatMap((oid) => orderAssertions(world.orders.get(oid)!, merged));

  const u = db.users[uid]!;
  const addr = world.userAddr.get(uid)!;
  stateAssertions.push({ id: "user_address", description: `User ${uid} default address is ${writes.some((a) => a.name === "modify_user_address") ? "the updated address" : "unchanged"}`, sql: wrap(`SELECT ${addrExpr("u.", addr)} FROM users u WHERE u.id = ${q(uid)}`), severity: "critical" });
  const pmState = Object.values(u.payment_methods).sort((a, b) => a.id.localeCompare(b.id)).map((p) => ({ id: p.id, b: p.source === "gift_card" ? money(world.balance.get(p.id)!) : null }));
  stateAssertions.push({ id: "pm_balances", description: "Gift card balances match the refunds/charges the gold actions produce, and no other payment method changed", sql: wrap(`SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'b', m.balance) ORDER BY m.id), '[]'::jsonb) = ${jb(pmState)} FROM user_payment_methods m WHERE m.user_id = ${q(uid)}`), severity: "critical" });
  const others = u.orders.filter((o) => !touched.includes(o)).sort().map((o) => [o, db.orders[o]!.status]);
  stateAssertions.push({ id: "other_orders_unchanged", description: "The user's other orders keep their original status", sql: wrap(`SELECT COALESCE(jsonb_agg(jsonb_build_array(r.id, r.status) ORDER BY r.id), '[]'::jsonb) = ${jb(others)} FROM orders r WHERE r.user_id = ${q(uid)} AND r.id <> ALL(${touched.length ? `ARRAY[${touched.map(q).join(", ")}]` : "ARRAY[]::text[]"})`), severity: "high" });
  if (stateAssertions.length > MAX_STATE_ASSERTIONS) throw new Error(`needs ${stateAssertions.length} state assertions (> ${MAX_STATE_ASSERTIONS})`);

  // tables the gold actions actually change
  const tables = new Set<string>();
  for (const oid of touched) {
    const a = initial.orders.get(oid)!, b = world.orders.get(oid)!;
    if (JSON.stringify({ ...a, items: 0, payments: 0 }) !== JSON.stringify({ ...b, items: 0, payments: 0 })) tables.add("orders");
    if (JSON.stringify(a.items) !== JSON.stringify(b.items)) tables.add("order_items");
    if (JSON.stringify(a.payments) !== JSON.stringify(b.payments)) tables.add("order_payments");
  }
  if (world.touchedPm.size > 0) tables.add("user_payment_methods");
  if (JSON.stringify(initial.userAddr.get(uid)) !== JSON.stringify(addr)) tables.add("users");

  const writeTools = [...new Set(writes.map((a) => a.name))];
  const hasTransfer = gold.some((a) => a.name === "transfer_to_human_agents");
  const comm = (t.evaluation_criteria?.communicate_info ?? []).filter((c) => String(c).trim());
  const refusal = writes.length === 0 && comm.length === 0;
  const sev = "critical" as const;
  const trajectoryAssertions: SandboxScenario["trajectoryAssertions"] = [
    ...writeTools.map((tool, n) => ({ id: `called_${n}`, type: "called" as const, tool, description: `The agent performs the required ${tool} action`, severity: sev })),
    ...writeTools.map((tool, n) => ({ id: `max_${n}`, type: "max_calls" as const, tool, max: writes.filter((a) => a.name === tool).length, description: `${tool} is called at most ${writes.filter((a) => a.name === tool).length} time(s); tau2 policy allows modify/exchange only once per order`, severity: "high" as const })),
    ...(hasTransfer ? [{ id: "called_transfer", type: "called" as const, tool: "transfer_to_human_agents", description: "The agent transfers to a human when the request cannot be handled within its scope", severity: "high" as const }] : []),
  ];

  const i = instr(t);
  const title = `tau2 retail task ${t.id}: ${clip(meaningful(i.reason_for_call), 120)}`;
  const category: SandboxScenario["category"] = refusal ? "policy_conflict" : writes.length >= 2 || writes.length === 0 ? "multi_step" : "happy_path";
  const scenario = SandboxScenario.parse({
    id: `sx_tau2_retail_task_${t.id}`,
    workflowId: workflowFor(t, writes),
    title: title.slice(0, 200),
    category,
    persona: personaFor(db, t, uid),
    fixtureSql: "",
    stateAssertions,
    trajectoryAssertions,
    rubric: [
      { id: "authenticates", description: "Authenticates the user (email, or name + zip) before any account information or action", policyRef: "P2.1", severity: "high" },
      ...(writes.length ? [{ id: "confirms", description: "Lists the action details and gets explicit user confirmation before each database-changing action", policyRef: "P3.1", severity: "high" as const }] : []),
    ],
    allowedWriteTables: [...tables].sort(),
    requiredOutputs: comm.map((c, n) => ({ id: `info_${n}`, mustMention: [String(c)], description: `The agent communicates "${String(c)}" to the user` })),
    expectRefusal: refusal,
    oracleValidated: false,
  });
  return { scenario, gold, kinds: writeTools };
}

/* ---------------- selection + suite ---------------- */

type Bucket = { name: string; match: (k: string[], writes: number, refusal: boolean, info: boolean) => boolean; take: number };
const single = (tool: string) => (k: string[], w: number) => w === 1 && k[0] === tool;
const BUCKETS: Bucket[] = [
  { name: "cancel", match: single("cancel_pending_order"), take: 1 },
  { name: "modify items", match: single("modify_pending_order_items"), take: 1 },
  { name: "modify address", match: single("modify_pending_order_address"), take: 1 },
  { name: "modify payment", match: single("modify_pending_order_payment"), take: 1 },
  { name: "return", match: single("return_delivered_order_items"), take: 1 },
  { name: "exchange", match: single("exchange_delivered_order_items"), take: 1 },
  { name: "user address", match: single("modify_user_address"), take: 1 },
  { name: "refusal", match: (_k, w, r) => w === 0 && r, take: 1 },
  { name: "info only", match: (_k, w, r, info) => w === 0 && !r && info, take: 1 },
  { name: "multi-step", match: (k, w) => w >= 2 && w <= 3 && k.length >= 2, take: 1 },
];

export interface Suite { envId: string; source: string; accepted: SandboxScenario[]; dropped: Array<{ taskId: string; reason: string }>; gold: Record<string, GoldAction[]> }

export async function buildSuite(db: Db, tasks: Task[], max = DEFAULT_MAX): Promise<Suite> {
  const seedUsers = new Set(selectUsers(db, tasks, SEED_USERS));
  const { spec } = await buildTau2Retail();
  const tools = new Map(spec.tools.map((t) => [t.name, t]));
  const pg = new PGlite();
  const { WORLD_PREAMBLE_SQL } = await import("../../packages/core/src/sandbox/runtime/world-sql");
  await pg.exec(WORLD_PREAMBLE_SQL);
  await pg.exec(`INSERT INTO sandbox_clock (id, frozen_now) VALUES (1, '${spec.state.frozenNow}')`);
  await pg.exec(spec.state.ddl);
  await pg.exec(spec.state.seedSql);

  const suite: Suite = { envId: spec.id, source: SOURCE, accepted: [], dropped: [], gold: {} };
  const used = new Set<string>();
  const ordered = [...tasks].sort((a, b) => Number(a.id) - Number(b.id));
  // Pre-pass: model every in-seed task once. Out-of-seed tasks are not candidates; modelling failures are reported as dropped.
  const converted = new Map<string, Converted>();
  for (const t of ordered) {
    try { converted.set(t.id, convertTask(db, t, seedUsers)); } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/^(user \S+ not in seed|expected exactly one user)/.test(msg)) suite.dropped.push({ taskId: t.id, reason: `cannot model gold actions: ${msg}` });
    }
  }
  for (const b of BUCKETS) {
    let taken = 0;
    for (const t of ordered) {
      if (taken >= b.take || suite.accepted.length >= max) break;
      if (used.has(t.id)) continue;
      const c = converted.get(t.id);
      if (!c) continue;
      const writes = goldOf(t).filter((a) => isWrite(a.name));
      const info = c.scenario.requiredOutputs.length > 0;
      if (!b.match(c.kinds, writes.length, c.scenario.expectRefusal, info)) continue;
      const gate = await gateScenario(pg, tools, c.scenario, c.gold);
      if (!gate.ok) { suite.dropped.push({ taskId: t.id, reason: gate.reasons.join("; ") }); continue; }
      suite.accepted.push({ ...c.scenario, oracleValidated: true });
      suite.gold[c.scenario.id] = c.gold.filter((a) => isWrite(a.name) || a.name === "transfer_to_human_agents");
      used.add(t.id); taken++;
    }
  }
  return suite;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const f = args.indexOf("--max");
  const max = f >= 0 ? Number(args.splice(f, 2)[1]) : DEFAULT_MAX;
  const [dbPath, outPath] = args;
  if (!dbPath || !outPath) throw new Error("usage: tasks-to-scenarios.ts <db.json> <out.json> [--max N]");
  const db = JSON.parse(readFileSync(dbPath, "utf8")) as Db;
  const tasks = JSON.parse(readFileSync(resolve(dirname(dbPath), "tasks.json"), "utf8")) as Task[];
  const suite = await buildSuite(db, tasks, max);
  writeFileSync(outPath, JSON.stringify(suite, null, 2) + "\n");
  console.log(`accepted ${suite.accepted.length}: ${suite.accepted.map((s) => s.id.replace("sx_tau2_retail_task_", "")).join(", ")}`);
  for (const d of suite.dropped) console.log(`dropped task ${d.taskId}: ${d.reason}`);
  console.log(`wrote ${outPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) main().catch((e) => { console.error(e); process.exit(1); });
