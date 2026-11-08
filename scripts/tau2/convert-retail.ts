/**
 * Converts a deterministic SUBSET of tau2-bench's retail db.json into data/envs/tau2-retail/seed.sql.
 *
 *   npx tsx scripts/tau2/convert-retail.ts <path/to/db.json> [out.sql] [--users N]
 *
 * Selection: users are taken in the order the first tasks in the sibling tasks.json touch them
 * (resolved from user_id / order_id / email / name+zip in each task's expected actions), up to N
 * (default 32). All of their orders are kept. The full product catalogue (50 products, all variants)
 * is kept so get_product_details / list_all_product_types are faithful. No randomness, no clock.
 * Source: https://github.com/sierra-research/tau2-bench (MIT, Sierra Research).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Addr = { address1: string; address2: string; city: string; state: string; country: string; zip: string };
export interface PayMethod { source: string; id: string; brand?: string; last_four?: string; balance?: number }
export interface User { user_id: string; name: { first_name: string; last_name: string }; address: Addr; email: string; payment_methods: Record<string, PayMethod>; orders: string[] }
export interface OrderItem { name: string; product_id: string; item_id: string; price: number; options: Record<string, string> }
export interface Order {
  order_id: string; user_id: string; address: Addr; items: OrderItem[]; status: string;
  fulfillments: Array<{ tracking_id: string[]; item_ids: string[] }>;
  payment_history: Array<{ transaction_type: string; amount: number; payment_method_id: string }>;
  cancel_reason?: string | null; exchange_items?: string[] | null; exchange_new_items?: string[] | null;
  exchange_payment_method_id?: string | null; exchange_price_difference?: number | null;
  return_items?: string[] | null; return_payment_method_id?: string | null;
}
export interface Product { name: string; product_id: string; variants: Record<string, { item_id: string; options: Record<string, string>; available: boolean; price: number }> }
export interface Db { products: Record<string, Product>; users: Record<string, User>; orders: Record<string, Order> }
export interface GoldAction { name: string; arguments: Record<string, unknown> }
export interface Task {
  id: string;
  user_scenario?: { instructions?: { task_instructions?: string | null; reason_for_call?: string | null; known_info?: string | null; unknown_info?: string | null } | string | null; persona?: unknown } | null;
  evaluation_criteria?: { actions?: GoldAction[] | null; communicate_info?: string[] | null; nl_assertions?: string[] | null } | null;
}

const DEFAULT_USERS = 32;

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const qn = (s: string | null | undefined): string => (s === null || s === undefined ? "NULL" : q(s));
const num = (n: number | null | undefined): string => (n === null || n === undefined ? "NULL" : String(Math.round(n * 100) / 100));
const jsonb = (v: unknown): string => (v === null || v === undefined ? "NULL" : `${q(JSON.stringify(v))}::jsonb`);
const fold = (s: string): string => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** User ids a gold action refers to (user_id / order_id owner / email / name+zip). */
export function actionUserIds(db: Db, args: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof args.user_id === "string") out.push(args.user_id);
  if (typeof args.order_id === "string" && db.orders[args.order_id]) out.push(db.orders[args.order_id]!.user_id);
  if (typeof args.email === "string") {
    const u = Object.values(db.users).find((x) => fold(x.email) === fold(args.email as string));
    if (u) out.push(u.user_id);
  }
  if (typeof args.first_name === "string" && typeof args.last_name === "string") {
    const u = Object.values(db.users).find((x) => fold(x.name.first_name) === fold(args.first_name as string) && fold(x.name.last_name) === fold(args.last_name as string) && x.address.zip === args.zip);
    if (u) out.push(u.user_id);
  }
  return out.filter((id) => db.users[id]);
}

export function selectUsers(db: Db, tasks: Task[], max: number): string[] {
  const chosen: string[] = [];
  const add = (id: string | undefined): void => {
    if (id && db.users[id] && !chosen.includes(id) && chosen.length < max) chosen.push(id);
  };
  for (const t of tasks) {
    for (const a of t.evaluation_criteria?.actions ?? []) for (const id of actionUserIds(db, a.arguments)) add(id);
    if (chosen.length >= max) break;
  }
  // Top up deterministically (sorted user id) if the tasks did not touch enough users.
  for (const id of Object.keys(db.users).sort()) add(id);
  return chosen.sort();
}

function rows(table: string, cols: string[], values: string[][]): string {
  if (values.length === 0) return "";
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES\n${values.map((v) => `(${v.join(", ")})`).join(",\n")};\n`;
}

export function buildSeed(db: Db, tasks: Task[], maxUsers: number): string {
  const userIds = selectUsers(db, tasks, maxUsers);
  const users = userIds.map((id) => db.users[id]!);
  const orders = Object.values(db.orders).filter((o) => userIds.includes(o.user_id)).sort((a, b) => a.order_id.localeCompare(b.order_id));
  const products = Object.values(db.products).sort((a, b) => a.product_id.localeCompare(b.product_id));

  const out: string[] = [
    `-- tau2-retail seed. Deterministic subset of tau2-bench retail db.json (MIT, Sierra Research).`,
    `-- ${users.length} users, ${orders.length} orders, ${products.length} products. Generated by scripts/tau2/convert-retail.ts - do not edit by hand.`,
    rows("users", ["id", "first_name", "last_name", "email", "address1", "address2", "city", "state", "country", "zip"],
      users.map((u) => [q(u.user_id), q(u.name.first_name), q(u.name.last_name), q(u.email), q(u.address.address1), q(u.address.address2), q(u.address.city), q(u.address.state), q(u.address.country), q(u.address.zip)])),
    rows("user_payment_methods", ["id", "user_id", "source", "brand", "last_four", "balance"],
      users.flatMap((u) => Object.values(u.payment_methods).map((p) => [q(p.id), q(u.user_id), q(p.source), qn(p.brand), qn(p.last_four), num(p.balance)]))),
    rows("products", ["id", "name"], products.map((p) => [q(p.product_id), q(p.name)])),
    rows("product_variants", ["item_id", "product_id", "options", "available", "price"],
      products.flatMap((p) => Object.values(p.variants).map((v) => [q(v.item_id), q(p.product_id), jsonb(v.options), v.available ? "true" : "false", num(v.price)]))),
    rows("orders", ["id", "user_id", "address1", "address2", "city", "state", "country", "zip", "status", "cancel_reason", "exchange_items", "exchange_new_items", "exchange_payment_method_id", "exchange_price_difference", "return_items", "return_payment_method_id"],
      orders.map((o) => [q(o.order_id), q(o.user_id), q(o.address.address1), q(o.address.address2), q(o.address.city), q(o.address.state), q(o.address.country), q(o.address.zip), q(o.status), qn(o.cancel_reason), jsonb(o.exchange_items), jsonb(o.exchange_new_items), qn(o.exchange_payment_method_id), num(o.exchange_price_difference), jsonb(o.return_items), qn(o.return_payment_method_id)])),
    rows("order_items", ["order_id", "product_id", "item_id", "name", "price", "options"],
      orders.flatMap((o) => o.items.map((i) => [q(o.order_id), q(i.product_id), q(i.item_id), q(i.name), num(i.price), jsonb(i.options)]))),
    rows("order_fulfillments", ["order_id", "tracking_ids", "item_ids"],
      orders.flatMap((o) => o.fulfillments.map((f) => [q(o.order_id), jsonb(f.tracking_id), jsonb(f.item_ids)]))),
    rows("order_payments", ["order_id", "transaction_type", "amount", "payment_method_id"],
      orders.flatMap((o) => o.payment_history.map((p) => [q(o.order_id), q(p.transaction_type), num(p.amount), q(p.payment_method_id)]))),
  ];
  return out.filter(Boolean).join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--users");
  const maxUsers = flag >= 0 ? Number(args.splice(flag, 2)[1]) : DEFAULT_USERS;
  const [dbPath, outPath = resolve(dirname(new URL(import.meta.url).pathname), "../../data/envs/tau2-retail/seed.sql")] = args;
  if (!dbPath || !Number.isInteger(maxUsers) || maxUsers < 1) throw new Error("usage: convert-retail.ts <db.json> [out.sql] [--users N]");
  const db = JSON.parse(readFileSync(dbPath, "utf8")) as Db;
  const tasks = JSON.parse(readFileSync(resolve(dirname(dbPath), "tasks.json"), "utf8")) as Task[];
  const sql = buildSeed(db, tasks, maxUsers);
  writeFileSync(outPath, sql);
  console.log(`wrote ${outPath} (${(sql.length / 1024).toFixed(1)} KB)`);
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();
