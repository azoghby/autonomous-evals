/**
 * Generates data/envs/tau2-retail/openapi.yaml (tool surface + x-sandbox-sql bindings) for the
 * tau2-bench retail domain. SQL fragments are shared across tools, so they live here as code.
 *
 *   npx tsx scripts/tau2/gen-retail-openapi.ts [out.yaml]
 *
 * Tool names/args/semantics follow src/tau2/domains/retail/tools.py (MIT, Sierra Research).
 * Preconditions that tools.py enforces with `raise ValueError` are encoded in the SQL (a failed
 * precondition leaves the database untouched and returns no row -> runtime error "not_found").
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { dump(o: unknown, opts?: object): string };

/* ---------------- shared SQL fragments ---------------- */

const ITEMS_DEFAULT = (o: string) => `SELECT x.id, x.name, x.product_id, x.item_id, x.price, x.options FROM order_items x WHERE x.order_id = ${o}.id`;
const PAYMENTS_DEFAULT = (o: string) => `SELECT x.id, x.transaction_type, x.amount, x.payment_method_id FROM order_payments x WHERE x.order_id = ${o}.id`;

/** Select list producing exactly tau2's Order object. `o` must expose the orders columns. */
function orderCols(o: string, itemsSrc = ITEMS_DEFAULT(o), paymentsSrc = PAYMENTS_DEFAULT(o)): string {
  return [
    `${o}.id AS order_id`,
    `${o}.user_id`,
    `json_build_object('address1', ${o}.address1, 'address2', ${o}.address2, 'city', ${o}.city, 'country', ${o}.country, 'state', ${o}.state, 'zip', ${o}.zip) AS address`,
    `COALESCE((SELECT json_agg(json_build_object('name', i.name, 'product_id', i.product_id, 'item_id', i.item_id, 'price', i.price, 'options', i.options) ORDER BY i.id) FROM (${itemsSrc}) i), '[]'::json) AS items`,
    `${o}.status`,
    `COALESCE((SELECT json_agg(json_build_object('tracking_id', f.tracking_ids, 'item_ids', f.item_ids) ORDER BY f.id) FROM order_fulfillments f WHERE f.order_id = ${o}.id), '[]'::json) AS fulfillments`,
    `COALESCE((SELECT json_agg(json_build_object('transaction_type', p.transaction_type, 'amount', p.amount, 'payment_method_id', p.payment_method_id) ORDER BY p.id) FROM (${paymentsSrc}) p), '[]'::json) AS payment_history`,
    `${o}.cancel_reason`,
    `${o}.exchange_items`,
    `${o}.exchange_new_items`,
    `${o}.exchange_payment_method_id`,
    `${o}.exchange_price_difference`,
    `${o}.return_items`,
    `${o}.return_payment_method_id`,
  ].join(", ");
}

/** Select list producing tau2's User object. `u` must expose the users columns. */
function userCols(u: string): string {
  return [
    `${u}.id AS user_id`,
    `json_build_object('first_name', ${u}.first_name, 'last_name', ${u}.last_name) AS name`,
    `json_build_object('address1', ${u}.address1, 'address2', ${u}.address2, 'city', ${u}.city, 'country', ${u}.country, 'state', ${u}.state, 'zip', ${u}.zip) AS address`,
    `${u}.email`,
    `COALESCE((SELECT json_object_agg(m.id, CASE m.source WHEN 'credit_card' THEN json_build_object('source', m.source, 'id', m.id, 'brand', m.brand, 'last_four', m.last_four) WHEN 'gift_card' THEN json_build_object('source', m.source, 'id', m.id, 'balance', m.balance) ELSE json_build_object('source', m.source, 'id', m.id) END ORDER BY m.id) FROM user_payment_methods m WHERE m.user_id = ${u}.id), '{}'::json) AS payment_methods`,
    `COALESCE((SELECT json_agg(r.id ORDER BY r.id) FROM orders r WHERE r.user_id = ${u}.id), '[]'::json) AS orders`,
  ].join(", ");
}

const withPrefix = (parts: string[]): string => `WITH ${parts.join(",\n")}`;
const ITEM_IDS = "CAST(:item_ids AS jsonb)";
const NEW_ITEM_IDS = "CAST(:new_item_ids AS jsonb)";
const REQ = `req AS (SELECT t.old_id, n.new_id, t.ord, row_number() OVER (PARTITION BY t.old_id ORDER BY t.ord) AS occ FROM jsonb_array_elements_text(${ITEM_IDS}) WITH ORDINALITY AS t(old_id, ord) JOIN jsonb_array_elements_text(${NEW_ITEM_IDS}) WITH ORDINALITY AS n(new_id, ord) ON n.ord = t.ord)`;
const SORTED_ITEM_IDS = `COALESCE((SELECT jsonb_agg(e.x ORDER BY e.x COLLATE "C") FROM jsonb_array_elements_text(${ITEM_IDS}) AS e(x)), '[]'::jsonb)`;
const SORTED_NEW_ITEM_IDS = `COALESCE((SELECT jsonb_agg(e.x ORDER BY e.x COLLATE "C") FROM jsonb_array_elements_text(${NEW_ITEM_IDS}) AS e(x)), '[]'::jsonb)`;
/** Every requested item id occurs in the order at least as often as requested (tools.py count check). */
const ITEMS_IN_ORDER = `NOT EXISTS (SELECT 1 FROM (SELECT e.x, count(*) AS c FROM jsonb_array_elements_text(${ITEM_IDS}) AS e(x) GROUP BY e.x) r WHERE r.c > (SELECT count(*) FROM order_items i WHERE i.order_id = :order_id AND i.item_id = r.x))`;
const SAME_LENGTH = `jsonb_array_length(${ITEM_IDS}) = jsonb_array_length(${NEW_ITEM_IDS})`;
const DIFF = "COALESCE((SELECT sum(m.new_price - m.old_price) FROM matched m), 0)";

/* ---------------- statements ---------------- */

const SQL = {
  find_user_id_by_email: `SELECT min(id) AS user_id FROM users WHERE lower(btrim(email)) = lower(btrim(:email)) HAVING count(*) = 1`,
  find_user_id_by_name_zip: `SELECT min(id) AS user_id FROM users WHERE lower(btrim(first_name)) = lower(btrim(:first_name)) AND lower(btrim(last_name)) = lower(btrim(:last_name)) AND zip = :zip HAVING count(*) = 1`,
  get_user_details: `SELECT ${userCols("u")} FROM users u WHERE u.id = :user_id`,
  get_order_details: `SELECT ${orderCols("o")} FROM orders o WHERE o.id = :order_id`,
  get_product_details: `SELECT p.name, p.id AS product_id, COALESCE((SELECT json_object_agg(v.item_id, json_build_object('item_id', v.item_id, 'options', v.options, 'available', v.available, 'price', v.price) ORDER BY v.item_id) FROM product_variants v WHERE v.product_id = p.id), '{}'::json) AS variants FROM products p WHERE p.id = :product_id`,
  list_all_product_types: `SELECT json_object_agg(name, id ORDER BY name COLLATE "C") AS product_types FROM products`,

  cancel_pending_order: withPrefix([
    `chk AS (SELECT o.id, o.user_id FROM orders o WHERE o.id = :order_id AND o.status = 'pending' AND :reason IN ('no longer needed', 'ordered by mistake'))`,
    `gc AS (UPDATE user_payment_methods pm SET balance = round(pm.balance + s.total, 2) FROM (SELECT p.payment_method_id, sum(p.amount) AS total FROM order_payments p JOIN chk ON chk.id = p.order_id GROUP BY p.payment_method_id) s, chk WHERE pm.id = s.payment_method_id AND pm.user_id = chk.user_id AND pm.source = 'gift_card' RETURNING pm.id)`,
    `ins AS (INSERT INTO order_payments (order_id, transaction_type, amount, payment_method_id) SELECT p.order_id, 'refund', p.amount, p.payment_method_id FROM order_payments p JOIN chk ON chk.id = p.order_id ORDER BY p.id RETURNING *)`,
    `upd AS (UPDATE orders SET status = 'cancelled', cancel_reason = :reason FROM chk WHERE orders.id = chk.id RETURNING orders.*)`,
  ]) + `\nSELECT ${orderCols("o", ITEMS_DEFAULT("o"), `${PAYMENTS_DEFAULT("o")} UNION ALL SELECT n.id, n.transaction_type, n.amount, n.payment_method_id FROM ins n WHERE n.order_id = o.id`)} FROM upd o`,

  modify_pending_order_address: `WITH upd AS (UPDATE orders SET address1 = :address1, address2 = :address2, city = :city, state = :state, country = :country, zip = :zip WHERE id = :order_id AND status LIKE '%pending%' RETURNING *)\nSELECT ${orderCols("o")} FROM upd o`,

  modify_pending_order_payment: withPrefix([
    `chk AS (SELECT o.id, o.user_id, p.amount, p.payment_method_id AS old_pm FROM orders o JOIN order_payments p ON p.order_id = o.id JOIN user_payment_methods npm ON npm.id = :payment_method_id AND npm.user_id = o.user_id WHERE o.id = :order_id AND o.status LIKE '%pending%' AND (SELECT count(*) FROM order_payments x WHERE x.order_id = o.id) = 1 AND p.transaction_type = 'payment' AND p.payment_method_id <> :payment_method_id AND (npm.source <> 'gift_card' OR npm.balance >= p.amount))`,
    `gc AS (UPDATE user_payment_methods pm SET balance = round(pm.balance + CASE WHEN pm.id = chk.old_pm THEN chk.amount ELSE 0 END - CASE WHEN pm.id = :payment_method_id THEN chk.amount ELSE 0 END, 2) FROM chk WHERE pm.user_id = chk.user_id AND pm.source = 'gift_card' AND pm.id IN (chk.old_pm, :payment_method_id) RETURNING pm.id)`,
    `ins AS (INSERT INTO order_payments (order_id, transaction_type, amount, payment_method_id) SELECT v.order_id, v.t, v.amount, v.pm FROM (SELECT chk.id AS order_id, 1 AS n, 'payment' AS t, chk.amount, CAST(:payment_method_id AS text) AS pm FROM chk UNION ALL SELECT chk.id, 2, 'refund', chk.amount, chk.old_pm FROM chk) v ORDER BY v.n RETURNING *)`,
  ]) + `\nSELECT ${orderCols("o", ITEMS_DEFAULT("o"), `${PAYMENTS_DEFAULT("o")} UNION ALL SELECT n.id, n.transaction_type, n.amount, n.payment_method_id FROM ins n WHERE n.order_id = o.id`)} FROM orders o JOIN chk ON chk.id = o.id`,

  modify_pending_order_items: withPrefix([
    `oi AS (SELECT i.*, row_number() OVER (PARTITION BY i.item_id ORDER BY i.id) AS occ FROM order_items i WHERE i.order_id = :order_id)`,
    REQ,
    `matched AS (SELECT oi.id AS line_id, r.new_id, v.price AS new_price, v.options AS new_options, oi.price AS old_price FROM req r JOIN oi ON oi.item_id = r.old_id AND oi.occ = r.occ JOIN product_variants v ON v.item_id = r.new_id AND v.product_id = oi.product_id AND v.available)`,
    `chk AS (SELECT o.id, o.user_id, ${DIFF} AS diff FROM orders o JOIN user_payment_methods pm ON pm.id = :payment_method_id AND pm.user_id = o.user_id WHERE o.id = :order_id AND o.status = 'pending' AND ${SAME_LENGTH} AND (SELECT count(*) FROM matched) = jsonb_array_length(${ITEM_IDS}) AND NOT EXISTS (SELECT 1 FROM req WHERE old_id = new_id) AND (pm.source <> 'gift_card' OR pm.balance >= ${DIFF}))`,
    `pay AS (INSERT INTO order_payments (order_id, transaction_type, amount, payment_method_id) SELECT chk.id, CASE WHEN chk.diff > 0 THEN 'payment' ELSE 'refund' END, abs(chk.diff), CAST(:payment_method_id AS text) FROM chk RETURNING *)`,
    `gc AS (UPDATE user_payment_methods pm SET balance = round(pm.balance - chk.diff, 2) FROM chk WHERE pm.id = :payment_method_id AND pm.user_id = chk.user_id AND pm.source = 'gift_card' RETURNING pm.id)`,
    `ui AS (UPDATE order_items i SET item_id = m.new_id, price = m.new_price, options = m.new_options FROM matched m, chk WHERE i.id = m.line_id AND i.order_id = chk.id RETURNING i.*)`,
    `uo AS (UPDATE orders SET status = 'pending (item modified)' FROM chk WHERE orders.id = chk.id RETURNING orders.*)`,
  ]) + `\nSELECT ${orderCols("o",
    `SELECT x.id, x.name, x.product_id, x.item_id, x.price, x.options FROM order_items x WHERE x.order_id = o.id AND x.id NOT IN (SELECT u.id FROM ui u) UNION ALL SELECT u.id, u.name, u.product_id, u.item_id, u.price, u.options FROM ui u`,
    `${PAYMENTS_DEFAULT("o")} UNION ALL SELECT n.id, n.transaction_type, n.amount, n.payment_method_id FROM pay n WHERE n.order_id = o.id`)} FROM uo o`,

  return_delivered_order_items: withPrefix([
    `chk AS (SELECT o.id FROM orders o JOIN user_payment_methods pm ON pm.id = :payment_method_id AND pm.user_id = o.user_id WHERE o.id = :order_id AND o.status = 'delivered' AND (pm.source = 'gift_card' OR pm.id = (SELECT p.payment_method_id FROM order_payments p WHERE p.order_id = o.id ORDER BY p.id LIMIT 1)) AND ${ITEMS_IN_ORDER})`,
    `upd AS (UPDATE orders SET status = 'return requested', return_items = ${SORTED_ITEM_IDS}, return_payment_method_id = :payment_method_id FROM chk WHERE orders.id = chk.id RETURNING orders.*)`,
  ]) + `\nSELECT ${orderCols("o")} FROM upd o`,

  exchange_delivered_order_items: withPrefix([
    REQ,
    `oi AS (SELECT DISTINCT ON (i.item_id) i.item_id, i.product_id, i.price FROM order_items i WHERE i.order_id = :order_id ORDER BY i.item_id, i.id)`,
    `matched AS (SELECT r.old_id, r.new_id, oi.price AS old_price, v.price AS new_price FROM req r JOIN oi ON oi.item_id = r.old_id JOIN product_variants v ON v.item_id = r.new_id AND v.product_id = oi.product_id AND v.available)`,
    `chk AS (SELECT o.id, round(${DIFF}, 2) AS diff FROM orders o JOIN user_payment_methods pm ON pm.id = :payment_method_id AND pm.user_id = o.user_id WHERE o.id = :order_id AND o.status = 'delivered' AND ${SAME_LENGTH} AND ${ITEMS_IN_ORDER} AND (SELECT count(*) FROM matched) = jsonb_array_length(${ITEM_IDS}) AND (pm.source <> 'gift_card' OR pm.balance >= round(${DIFF}, 2)))`,
    `upd AS (UPDATE orders SET status = 'exchange requested', exchange_items = ${SORTED_ITEM_IDS}, exchange_new_items = ${SORTED_NEW_ITEM_IDS}, exchange_payment_method_id = :payment_method_id, exchange_price_difference = chk.diff FROM chk WHERE orders.id = chk.id RETURNING orders.*)`,
  ]) + `\nSELECT ${orderCols("o")} FROM upd o`,

  modify_user_address: `WITH upd AS (UPDATE users SET address1 = :address1, address2 = :address2, city = :city, state = :state, country = :country, zip = :zip WHERE id = :user_id RETURNING *)\nSELECT ${userCols("u")} FROM upd u`,

  transfer_to_human_agents: `INSERT INTO sandbox_outbox (tool, args, payload) VALUES ('transfer_to_human_agents', jsonb_build_object('summary', CAST(:summary AS text)), jsonb_build_object('summary', CAST(:summary AS text), 'result', 'Transfer successful')) RETURNING 'Transfer successful' AS result`,
} as const;

/* ---------------- OpenAPI assembly ---------------- */

type Obj = Record<string, unknown>;
const str = (description: string, example: unknown): Obj => ({ type: "string", description, example });
const strList = (description: string, example: string[]): Obj => ({ type: "array", items: { type: "string" }, description, example });

const ORDER_ID = str("The order id, such as '#W0000000'. Be careful there is a '#' symbol at the beginning of the order id.", "#W1267569");
const USER_ID = str("The user id, such as 'sara_doe_496'.", "mei_davis_8935");
const PRODUCT_ID = str("The product id, such as '6086499569'. Be careful the product id is different from the item id.", "9523456873");
const PAYMENT_METHOD_DIFF = (ex: string): Obj => str("The payment method id to pay or receive refund for the item price difference, such as 'gift_card_0000000' or 'credit_card_0000000'. These can be looked up from the user or order details.", ex);
const ADDRESS_PROPS: Obj = {
  address1: str("The first line of the address, such as '123 Main St'.", "123 Main St"),
  address2: str("The second line of the address, such as 'Apt 1' or ''.", "Apt 1"),
  city: str("The city, such as 'San Francisco'.", "San Francisco"),
  state: str("The state, such as 'CA'.", "CA"),
  country: str("The country, such as 'USA'.", "USA"),
  zip: str("The zip code, such as '12345'.", "12345"),
};
const ADDRESS_REQUIRED = Object.keys(ADDRESS_PROPS);

const ADDRESS_OBJ: Obj = { type: "object", properties: Object.fromEntries(ADDRESS_REQUIRED.map((k) => [k, { type: "string" }])) };
const ORDER_SCHEMA: Obj = {
  type: "object",
  required: ["order_id", "user_id", "address", "items", "status", "fulfillments", "payment_history"],
  properties: {
    order_id: { type: "string", example: "#W1267569" }, user_id: { type: "string" }, address: ADDRESS_OBJ,
    items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, product_id: { type: "string" }, item_id: { type: "string" }, price: { type: "number" }, options: { type: "object" } } } },
    status: { type: "string", enum: ["pending", "pending (item modified)", "processed", "delivered", "cancelled", "exchange requested", "return requested"] },
    fulfillments: { type: "array", items: { type: "object", properties: { tracking_id: { type: "array", items: { type: "string" } }, item_ids: { type: "array", items: { type: "string" } } } } },
    payment_history: { type: "array", items: { type: "object", properties: { transaction_type: { type: "string", enum: ["payment", "refund"] }, amount: { type: "number" }, payment_method_id: { type: "string" } } } },
    cancel_reason: { type: ["string", "null"] }, exchange_items: { type: ["array", "null"], items: { type: "string" } }, exchange_new_items: { type: ["array", "null"], items: { type: "string" } },
    exchange_payment_method_id: { type: ["string", "null"] }, exchange_price_difference: { type: ["number", "null"] }, return_items: { type: ["array", "null"], items: { type: "string" } }, return_payment_method_id: { type: ["string", "null"] },
  },
};
const USER_SCHEMA: Obj = {
  type: "object",
  required: ["user_id", "name", "address", "email", "payment_methods", "orders"],
  properties: { user_id: { type: "string" }, name: { type: "object", properties: { first_name: { type: "string" }, last_name: { type: "string" } } }, address: ADDRESS_OBJ, email: { type: "string" }, payment_methods: { type: "object" }, orders: { type: "array", items: { type: "string" } } },
};
const ok = (schema: Obj): Obj => ({ "200": { description: "OK", content: { "application/json": { schema } } } });

interface Op {
  id: string; method: "get" | "post"; path: string; summary: string; description: string;
  effect: "read" | "write" | "external"; query?: Obj; body?: Obj; required?: string[]; out: Obj; sql?: { text: string; shape: "row" | "rows" };
}

const ORDER_WRITE_NOTE = " If a precondition fails the database is left unchanged and the call returns an error.";
const OPS: Op[] = [
  { id: "calculate", method: "post", path: "/calculate", effect: "read", summary: "Calculate the result of a mathematical expression.",
    description: "The expression can contain numbers, operators (+, -, *, /), parentheses, and spaces. Returns the result of the expression as a string rounded to 2 decimal places (for example '2 + 2' returns '4.0'). Any other character is an invalid expression and is an error.",
    body: { expression: str("The mathematical expression to calculate, such as '2 + 2'. The expression can contain numbers, operators (+, -, *, /), parentheses, and spaces.", "2 + 2") }, required: ["expression"], out: { type: "string", example: "4.0" } },
  { id: "cancel_pending_order", method: "post", path: "/orders/{order_id}/cancel", effect: "write", summary: "Cancel a pending order.",
    description: "Cancel a pending order. If the order is already processed or delivered, it cannot be cancelled. The agent needs to explain the cancellation detail and ask for explicit user confirmation (yes/no) to proceed. If the user confirms, the order status will be changed to 'cancelled' and the payment will be refunded. The refund will be added to the user's gift card balance immediately if the payment was made using a gift card, otherwise the refund would take 5-7 business days to process. The function returns the order details after the cancellation." + ORDER_WRITE_NOTE,
    query: { order_id: ORDER_ID }, body: { reason: { type: "string", enum: ["no longer needed", "ordered by mistake"], description: "The reason for cancellation, which should be either 'no longer needed' or 'ordered by mistake'.", example: "no longer needed" } }, required: ["order_id", "reason"], out: ORDER_SCHEMA, sql: { text: SQL.cancel_pending_order, shape: "row" } },
  { id: "exchange_delivered_order_items", method: "post", path: "/orders/{order_id}/exchange", effect: "write", summary: "Exchange items in a delivered order to new items of the same product type.",
    description: "Exchange items in a delivered order to new items of the same product type. For a delivered order, return or exchange can be only done once by the agent. The agent needs to explain the exchange detail and ask for explicit user confirmation (yes/no) to proceed. The order status becomes 'exchange requested'. Each new item must be an available variant of the same product as the item it replaces; if the payment method is a gift card it must have enough balance to cover the price difference." + ORDER_WRITE_NOTE,
    query: { order_id: ORDER_ID }, body: {
      item_ids: strList("The item ids to be exchanged, each such as '1008292230'. There could be duplicate items in the list.", ["1008292230"]),
      new_item_ids: strList("The item ids to be exchanged for, each such as '1008292230'. There could be duplicate items in the list. Each new item id should match the item id in the same position and be of the same product.", ["1008292231"]),
      payment_method_id: PAYMENT_METHOD_DIFF("credit_card_0000000"),
    }, required: ["order_id", "item_ids", "new_item_ids", "payment_method_id"], out: ORDER_SCHEMA, sql: { text: SQL.exchange_delivered_order_items, shape: "row" } },
  { id: "find_user_id_by_name_zip", method: "get", path: "/users/lookup-by-name", effect: "read", summary: "Find user id by first name, last name, and zip code.",
    description: "Find user id by first name, last name, and zip code. If the user is not found (or the match is ambiguous), the call returns an error. By default, find user id by email, and only call this function if the user is not found by email or cannot remember email.",
    query: { first_name: str("The first name of the customer, such as 'John'.", "Mei"), last_name: str("The last name of the customer, such as 'Doe'.", "Davis"), zip: str("The zip code of the customer, such as '12345'.", "80217") }, required: ["first_name", "last_name", "zip"],
    out: { type: "object", required: ["user_id"], properties: { user_id: { type: "string", example: "mei_davis_8935" } } }, sql: { text: SQL.find_user_id_by_name_zip, shape: "row" } },
  { id: "find_user_id_by_email", method: "get", path: "/users/lookup-by-email", effect: "read", summary: "Find user id by email.",
    description: "Find user id by email. If the user is not found (or the match is ambiguous), the call returns an error.",
    query: { email: str("The email of the user, such as 'something@example.com'.", "mei.davis6811@example.com") }, required: ["email"],
    out: { type: "object", required: ["user_id"], properties: { user_id: { type: "string", example: "mei_davis_8935" } } }, sql: { text: SQL.find_user_id_by_email, shape: "row" } },
  { id: "get_order_details", method: "get", path: "/orders/{order_id}", effect: "read", summary: "Get the status and details of an order.", description: "Get the status and details of an order.",
    query: { order_id: ORDER_ID }, required: ["order_id"], out: ORDER_SCHEMA, sql: { text: SQL.get_order_details, shape: "row" } },
  { id: "get_product_details", method: "get", path: "/products/{product_id}", effect: "read", summary: "Get the inventory details of a product.", description: "Get the inventory details of a product, including every variant item with its options, availability and price.",
    query: { product_id: PRODUCT_ID }, required: ["product_id"],
    out: { type: "object", required: ["name", "product_id", "variants"], properties: { name: { type: "string" }, product_id: { type: "string" }, variants: { type: "object", description: "Variants keyed by item id; each has item_id, options, available, price." } } }, sql: { text: SQL.get_product_details, shape: "row" } },
  { id: "get_user_details", method: "get", path: "/users/{user_id}", effect: "read", summary: "Get the details of a user, including their orders.", description: "Get the details of a user, including their orders.",
    query: { user_id: USER_ID }, required: ["user_id"], out: USER_SCHEMA, sql: { text: SQL.get_user_details, shape: "row" } },
  { id: "list_all_product_types", method: "get", path: "/products", effect: "read", summary: "List the name and product id of all product types.", description: "List the name and product id of all product types. Each product type has a variety of different items with unique item ids and options. Returns an object mapping product names to their product IDs, sorted alphabetically by name.",
    out: { type: "object", required: ["product_types"], properties: { product_types: { type: "object", description: "Product name -> product id." } } }, sql: { text: SQL.list_all_product_types, shape: "row" } },
  { id: "modify_pending_order_address", method: "post", path: "/orders/{order_id}/address", effect: "write", summary: "Modify the shipping address of a pending order.",
    description: "Modify the shipping address of a pending order. The agent needs to explain the modification detail and ask for explicit user confirmation (yes/no) to proceed." + ORDER_WRITE_NOTE,
    query: { order_id: ORDER_ID }, body: ADDRESS_PROPS, required: ["order_id", ...ADDRESS_REQUIRED], out: ORDER_SCHEMA, sql: { text: SQL.modify_pending_order_address, shape: "row" } },
  { id: "modify_pending_order_items", method: "post", path: "/orders/{order_id}/items", effect: "write", summary: "Modify items in a pending order to new items of the same product type.",
    description: "Modify items in a pending order to new items of the same product type. For a pending order, this function can only be called once. The agent needs to explain the exchange detail and ask for explicit user confirmation (yes/no) to proceed. The order status becomes 'pending (item modified)'. The price difference is charged to (or refunded to) the given payment method; a gift card must have enough balance." + ORDER_WRITE_NOTE,
    query: { order_id: ORDER_ID }, body: {
      item_ids: strList("The item ids to be modified, each such as '1008292230'. There could be duplicate items in the list.", ["1008292230"]),
      new_item_ids: strList("The item ids to be modified for, each such as '1008292230'. There could be duplicate items in the list. Each new item id should match the item id in the same position and be of the same product.", ["1008292231"]),
      payment_method_id: PAYMENT_METHOD_DIFF("credit_card_0000000"),
    }, required: ["order_id", "item_ids", "new_item_ids", "payment_method_id"], out: ORDER_SCHEMA, sql: { text: SQL.modify_pending_order_items, shape: "row" } },
  { id: "modify_pending_order_payment", method: "post", path: "/orders/{order_id}/payment", effect: "write", summary: "Modify the payment method of a pending order.",
    description: "Modify the payment method of a pending order. The agent needs to explain the modification detail and ask for explicit user confirmation (yes/no) to proceed. The new payment method must differ from the current one, and a gift card must have enough balance to cover the order amount." + ORDER_WRITE_NOTE,
    query: { order_id: ORDER_ID }, body: { payment_method_id: str("The payment method id to pay or receive refund for the item price difference, such as 'gift_card_0000000' or 'credit_card_0000000'. These can be looked up from the user or order details.", "credit_card_0000000") }, required: ["order_id", "payment_method_id"], out: ORDER_SCHEMA, sql: { text: SQL.modify_pending_order_payment, shape: "row" } },
  { id: "modify_user_address", method: "post", path: "/users/{user_id}/address", effect: "write", summary: "Modify the default address of a user.",
    description: "Modify the default address of a user. The agent needs to explain the modification detail and ask for explicit user confirmation (yes/no) to proceed.",
    query: { user_id: USER_ID }, body: ADDRESS_PROPS, required: ["user_id", ...ADDRESS_REQUIRED], out: USER_SCHEMA, sql: { text: SQL.modify_user_address, shape: "row" } },
  { id: "return_delivered_order_items", method: "post", path: "/orders/{order_id}/return", effect: "write", summary: "Return some items of a delivered order.",
    description: "Return some items of a delivered order. The order status will be changed to 'return requested'. The agent needs to explain the return detail and ask for explicit user confirmation (yes/no) to proceed. The user will receive follow-up email for how and where to return the item. The refund payment method must be the original payment method or a gift card of the user." + ORDER_WRITE_NOTE,
    query: { order_id: ORDER_ID }, body: {
      item_ids: strList("The item ids to be returned, each such as '1008292230'. There could be duplicate items in the list.", ["1008292230"]),
      payment_method_id: PAYMENT_METHOD_DIFF("credit_card_0000000"),
    }, required: ["order_id", "item_ids", "payment_method_id"], out: ORDER_SCHEMA, sql: { text: SQL.return_delivered_order_items, shape: "row" } },
  { id: "transfer_to_human_agents", method: "post", path: "/transfers", effect: "external", summary: "Transfer the user to a human agent, with a summary of the user's issue.",
    description: "Transfer the user to a human agent, with a summary of the user's issue. Only transfer if the user explicitly asks for a human agent, or given the policy and the available tools, you cannot solve the user's issue. Returns a message indicating the user has been transferred to a human agent; the transfer is recorded in the sandbox outbox.",
    body: { summary: str("A summary of the user's issue.", "The user wants a price match, which is not supported.") }, required: ["summary"], out: { type: "object", required: ["result"], properties: { result: { type: "string", example: "Transfer successful" } } }, sql: { text: SQL.transfer_to_human_agents, shape: "row" } },
];

function pathParams(path: string): string[] { return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!); }

function buildDoc(): Obj {
  const paths: Record<string, Obj> = {};
  for (const op of OPS) {
    const inPath = new Set(pathParams(op.path));
    const parameters = Object.entries(op.query ?? {}).map(([name, schema]) => {
      const { description, example, ...rest } = schema as Obj;
      return { name, in: inPath.has(name) ? "path" : "query", required: (op.required ?? []).includes(name), description, schema: rest, example };
    });
    const bodyKeys = Object.keys(op.body ?? {});
    const operation: Obj = {
      operationId: op.id, summary: op.summary, description: op.description, "x-effect": op.effect,
      ...(op.sql ? { "x-sandbox-sql": { resultShape: op.sql.shape, statements: [op.sql.text] } } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(bodyKeys.length ? { requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: bodyKeys.filter((k) => (op.required ?? []).includes(k)), properties: op.body } } } } } : {}),
      responses: ok(op.out),
    };
    (paths[op.path] ??= {})[op.method] = operation;
  }
  return {
    openapi: "3.1.0",
    info: { title: "tau2-bench Retail API", version: "1.0.0", description: "Retail customer-service backend converted from tau2-bench (Sierra Research, MIT). Look up users, orders and products; cancel or modify pending orders; return or exchange delivered orders; update a user's default address; transfer to a human agent." },
    servers: [{ url: "https://api.retail.example/v1" }],
    paths,
  };
}

const outPath = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../data/envs/tau2-retail/openapi.yaml");
writeFileSync(outPath, yaml.dump(buildDoc(), { lineWidth: -1, noRefs: true }));
console.log(`wrote ${outPath}`);
