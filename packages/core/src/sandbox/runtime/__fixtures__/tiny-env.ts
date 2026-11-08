/** Tiny support-desk world used by unit tests (PGlite) and the live test when data/envs/acme-support is absent. */
import type { EnvironmentSpec, SandboxScenario } from "../../spec";

export const TINY_DDL = `
CREATE TABLE customers (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL);
CREATE TABLE orders (id text PRIMARY KEY, customer_id text NOT NULL REFERENCES customers(id), total_cents int NOT NULL, status text NOT NULL, placed_at timestamptz NOT NULL);
CREATE TABLE refunds (id bigserial PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), amount_cents int NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT sandbox_now());
`;
export const TINY_SEED = `
INSERT INTO customers VALUES ('cus_1', 'Ada O''Neil', 'ada@example.test'), ('cus_2', 'Bo Chen', 'bo@example.test');
INSERT INTO orders VALUES ('ord_1', 'cus_1', 4720, 'delivered', sandbox_now() - interval '10 days'),
                          ('ord_2', 'cus_2', 1999, 'delivered', sandbox_now() - interval '45 days');
`;

export function tinyEnv(overrides: Partial<EnvironmentSpec> = {}): EnvironmentSpec {
  return {
    specVersion: "sandbox-spec-v1",
    id: "tiny_support",
    name: "Tiny support",
    domain: "support",
    tools: [
      {
        name: "get_order", description: "Look up an order", effect: "read", source: "json:get_order",
        inputSchema: { type: "object", properties: { order_id: { type: "string", pattern: "^ord_" } }, required: ["order_id"], additionalProperties: false },
        binding: { kind: "sql", statements: ["SELECT id, customer_id, total_cents, status FROM orders WHERE id = :order_id"], resultShape: "row" },
      },
      {
        name: "search_customers", description: "Search customers by name", effect: "read", source: "json:search_customers",
        inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        binding: { kind: "sql", statements: ["SELECT id, name FROM customers WHERE name ILIKE '%' || :q || '%' ORDER BY id"], resultShape: "rows" },
      },
      {
        name: "refund_order", description: "Refund an order", effect: "write", source: "json:refund_order",
        inputSchema: { type: "object", properties: { order_id: { type: "string" }, amount_cents: { type: "integer", minimum: 1 }, reason: { type: "string" } }, required: ["order_id", "amount_cents"] },
        binding: { kind: "sql", statements: [
          "INSERT INTO refunds(order_id, amount_cents, reason) VALUES (:order_id, :amount_cents, :reason)",
          "UPDATE orders SET status = 'refunded' WHERE id = :order_id RETURNING id, status",
        ], resultShape: "row" },
      },
      {
        name: "delete_customer", description: "Delete a customer (dangerous)", effect: "write", source: "json:delete_customer",
        inputSchema: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"] },
        binding: { kind: "sql", statements: ["UPDATE customers SET email = 'deleted@example.test' WHERE id = :customer_id"], resultShape: "count" },
      },
      {
        name: "send_email", description: "Email the customer", effect: "external", source: "json:send_email",
        inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } }, required: ["to", "body"] },
        outputSchema: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] },
        binding: { kind: "simulated", instructions: "Pretend to send the email.", readsTables: ["customers"], recordsOutbox: true },
      },
      {
        name: "staging_lookup", description: "Passthrough", effect: "read", source: "openapi:GET /x",
        inputSchema: { type: "object" },
        binding: { kind: "passthrough", method: "GET", urlTemplate: "https://staging.example.test/x" },
      },
    ],
    state: { ddl: TINY_DDL, seedSql: TINY_SEED, frozenNow: "2026-06-01T15:00:00Z", reportTables: ["orders", "refunds"] },
    policies: [],
    workflows: [{ id: "refunds", name: "Refunds", description: "Refund flow", tools: ["get_order", "refund_order"], invariants: [], policyRefs: [] }],
    integration: { mode: "tool_loop", endpointUrl: "https://agent.example.test/v1", model: "x" },
    ...overrides,
  } as EnvironmentSpec;
}

export function tinyScenario(overrides: Partial<SandboxScenario> = {}): SandboxScenario {
  return {
    id: "sx_refund_happy",
    workflowId: "refunds",
    title: "Refund a recent order",
    category: "happy_path",
    persona: { name: "Ada", goal: "refund", knowledge: [], style: "polite", adversarial: false, modality: "text", maxTurns: 8 },
    fixtureSql: "",
    faults: [],
    attachments: [],
    stateAssertions: [],
    trajectoryAssertions: [],
    rubric: [],
    allowedWriteTables: ["refunds", "orders"],
    expectedChanges: [],
    allowedChanges: [],
    requiredOutputs: [],
    expectRefusal: false,
    oracleValidated: false,
    ...overrides,
  } as SandboxScenario;
}
