import { beforeEach, describe, expect, it, vi } from "vitest";

let sessions: Array<Record<string, unknown>> = [];
vi.mock("./stripe", () => ({
  stripe: () => ({ checkout: { sessions: { list: () => (async function* () { yield* sessions; })() } } }),
  getStripeMode: () => "test",
}));
const record = vi.fn();
vi.mock("./plans-checkout", () => ({ recordPlanPurchase: (...a: unknown[]) => record(...a) }));
vi.mock("../db/client", () => ({
  db: () => ({ select: () => ({ from: () => ({ where: async () => [] }) }) }),
  schema: new Proxy({}, { get: () => new Proxy({}, { get: (_t, c) => String(c) }) }),
}));

import { reconcile } from "./checkout";

beforeEach(() => { record.mockReset(); sessions = []; });

describe("reconcile (missed webhooks)", () => {
  it("records paid plan and Agent Audit sessions that the webhook missed", async () => {
    sessions = [
      { id: "cs_audit", payment_status: "paid", metadata: { kind: "agent_audit", customer_id: "c1" } },
      { id: "cs_plan", payment_status: "paid", metadata: { kind: "plan", plan: "pro", interval: "month", customer_id: "c1" } },
      { id: "cs_open", payment_status: "unpaid", metadata: { kind: "agent_audit" } },
    ];
    record.mockResolvedValueOnce({ inserted: true }).mockResolvedValueOnce({ inserted: false });
    const out = await reconcile(vi.fn());
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(["cs_audit", "cs_plan"]);
    expect(out).toMatchObject({ sessionsChecked: 3, recorded: 1, errors: [] });
  });

  it("reports a failed plan record as an error without stopping", async () => {
    sessions = [{ id: "cs_a", payment_status: "paid", metadata: { kind: "agent_audit" } }];
    record.mockRejectedValue(new Error("db down"));
    const out = await reconcile(vi.fn());
    expect(out.errors).toEqual(["cs_a: db down"]);
  });
});
