/** Shared test fixtures: a tiny support world, its EnvironmentSpec and a validated-shape refund scenario. */
import { EnvironmentSpec, SandboxScenario } from "../../spec";
import type { StateMutation } from "../types";
import type { FakeWorld, Tables } from "./fake-runtime";

export const REFUND_OK_SQL = "SELECT EXISTS(SELECT 1 FROM refunds WHERE order_id = 'o_100' AND amount = 47.20) AS ok";
export const NO_REFUND_SQL = "SELECT NOT EXISTS(SELECT 1 FROM refunds) AS ok";
export const TRIVIAL_SQL = "SELECT true AS ok";
export const DROP_REFUND_SQL = "DELETE FROM refunds WHERE order_id = 'o_100'";
export const BUMP_AMOUNT_SQL = "UPDATE refunds SET amount = amount + 10 WHERE order_id = 'o_100'";
export const COLLATERAL_SQL = "UPDATE customers SET email = 'x@example.com' WHERE id = 'c_1'";

export const miniEnv: EnvironmentSpec = EnvironmentSpec.parse({
  specVersion: "sandbox-spec-v1",
  id: "mini_support",
  name: "Mini Support",
  domain: "e-commerce support",
  tools: [
    { name: "verify_identity", description: "Verify a customer by id and email", inputSchema: { type: "object", properties: { customer_id: { type: "string" }, email: { type: "string" } }, required: ["customer_id", "email"] }, effect: "read", binding: { kind: "sql", statements: ["SELECT id FROM customers WHERE id = :customer_id AND email = :email"], resultShape: "row" }, source: "json:verify_identity" },
    { name: "lookup_order", description: "Look up an order", inputSchema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] }, effect: "read", binding: { kind: "sql", statements: ["SELECT * FROM orders WHERE id = :order_id"], resultShape: "row" }, source: "json:lookup_order" },
    { name: "refund_order", description: "Refund an order", inputSchema: { type: "object", properties: { order_id: { type: "string" }, amount: { type: "number" } }, required: ["order_id", "amount"] }, effect: "write", binding: { kind: "sql", statements: ["INSERT INTO refunds (id, order_id, amount) VALUES ('r_' || :order_id, :order_id, :amount)", "UPDATE orders SET status = 'refunded' WHERE id = :order_id"], resultShape: "none" }, source: "json:refund_order" },
    { name: "send_email", description: "Email a customer", inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } }, required: ["to", "body"] }, effect: "external", binding: { kind: "simulated", instructions: "Return {sent:true}", recordsOutbox: true }, source: "json:send_email" },
  ],
  state: {
    ddl: "CREATE TABLE customers (id text primary key, email text, name text);\nCREATE TABLE orders (id text primary key, customer_id text, total numeric, status text, days_old int);\nCREATE TABLE refunds (id text primary key, order_id text, amount numeric);",
    seedSql: "INSERT INTO customers VALUES ('c_1','ann@example.com','Ann');\nINSERT INTO orders VALUES ('o_100','c_1',47.20,'delivered',10);",
    reportTables: ["orders", "refunds"],
  },
  policies: [{ id: "refund_policy", title: "Refund policy", clauses: [
    { id: "r1", text: "Refunds are allowed within 30 days of delivery." },
    { id: "r2", text: "Verify identity before any refund." },
  ] }],
  workflows: [{ id: "refund_request", name: "Refund request", description: "Customer asks for a refund", tools: ["verify_identity", "lookup_order", "refund_order"], invariants: ["identity verified before refund"], policyRefs: ["refund_policy:r1", "refund_policy:r2"] }],
  integration: { mode: "tool_loop", endpointUrl: "https://agent.example.com/v1/chat/completions", model: "test-model" },
});

export const miniWorld: FakeWorld = {
  seed: (): Tables => ({
    customers: [{ id: "c_1", email: "ann@example.com", name: "Ann" }],
    orders: [{ id: "o_100", customer_id: "c_1", total: 47.2, status: "delivered", days_old: 10 }],
    refunds: [],
  }),
  tools: {
    verify_identity: (t, a) => {
      const c = t.customers!.find((r) => r.id === a.customer_id && r.email === a.email);
      if (!c) throw new Error("not_found");
      return { id: c.id };
    },
    lookup_order: (t, a) => {
      const o = t.orders!.find((r) => r.id === a.order_id);
      if (!o) throw new Error("not_found");
      return o;
    },
    refund_order: (t, a) => {
      const o = t.orders!.find((r) => r.id === a.order_id);
      if (!o) throw new Error("not_found");
      t.refunds!.push({ id: `r_${String(a.order_id)}`, order_id: a.order_id, amount: Number(a.amount) });
      o.status = "refunded";
      return null;
    },
    send_email: () => ({ sent: true }),
  },
  queries: {
    [REFUND_OK_SQL]: (t) => [{ ok: t.refunds!.some((r) => r.order_id === "o_100" && Math.abs(Number(r.amount) - 47.2) < 1e-9) }],
    [NO_REFUND_SQL]: (t) => [{ ok: t.refunds!.length === 0 }],
    [TRIVIAL_SQL]: () => [{ ok: true }],
  },
  execs: {
    [DROP_REFUND_SQL]: (t) => { t.refunds = t.refunds!.filter((r) => r.order_id !== "o_100"); },
    [BUMP_AMOUNT_SQL]: (t) => { for (const r of t.refunds!) if (r.order_id === "o_100") r.amount = Number(r.amount) + 10; },
    [COLLATERAL_SQL]: (t) => { for (const c of t.customers!) if (c.id === "c_1") c.email = "x@example.com"; },
  },
};

/** Solvable refund scenario: verify → refund 47.20 → tell the user the amount. */
export const refundScenario: SandboxScenario = SandboxScenario.parse({
  id: "sx_refund_happy_1",
  workflowId: "refund_request",
  title: "Refund a recent delivered order",
  category: "happy_path",
  persona: {
    name: "Ann",
    goal: "Get a refund for order o_100",
    knowledge: [
      { fact: "My order id is o_100", revealWhen: "upfront" },
      { fact: "My customer id is c_1", revealWhen: "when_asked" },
      { fact: "My email is ann@example.com", revealWhen: "when_asked" },
    ],
    style: "traits: impatience=0.3, confusion=0.1, skepticism=0.2, verbosity=0.4; polite",
    maxTurns: 6,
  },
  stateAssertions: [{ id: "refund_created", description: "Refund of 47.20 exists for o_100", sql: REFUND_OK_SQL, severity: "critical" }],
  trajectoryAssertions: [
    { id: "verify_first", type: "before", first: "verify_identity", then: "refund_order", description: "Identity verified before refund", severity: "critical" },
    { id: "refund_called", type: "called", tool: "refund_order", description: "Refund issued", severity: "high" },
  ],
  rubric: [{ id: "tone", description: "Polite and clear", policyRef: "refund_policy:r1", severity: "low" }],
  allowedWriteTables: ["refunds", "orders"],
  expectedChanges: [{ id: "refund_row", description: "refund row inserted", sql: REFUND_OK_SQL }],
  allowedChanges: [{ table: "refunds", description: "the refund" }, { table: "orders", description: "status → refunded" }],
  requiredOutputs: [{ id: "amount", mustMention: ["47.20"], description: "Tell the customer the refund amount" }],
});

export const refundMutations: StateMutation[] = [
  { id: "m_drop", kind: "drop_expected", sql: DROP_REFUND_SQL },
  { id: "m_amount", kind: "change_amount", sql: BUMP_AMOUNT_SQL },
  { id: "m_collateral", kind: "collateral", sql: COLLATERAL_SQL },
];
