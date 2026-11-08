import { describe, expect, it } from "vitest";
import { billOverageForPeriod, type BillableCustomer, type InvoiceItemInput, type OverageDeps, type OverageRow, type StoredOverageRow } from "./overage-billing";
import { previousUsagePeriod } from "../pricing/overage";

const now = new Date("2026-11-02T07:00:00Z");
const period = previousUsagePeriod(now);

function makeDeps(customers: BillableCustomer[], usage: Record<string, number>, failFor: Set<string> = new Set()) {
  const rows = new Map<string, StoredOverageRow>();
  const calls: InvoiceItemInput[] = [];
  let seq = 0;
  const setStatus = (id: string, patch: Partial<StoredOverageRow>) => {
    for (const [k, v] of rows) if (v.id === id) rows.set(k, { ...v, ...patch });
  };
  const deps: OverageDeps = {
    listBillableCustomers: async () => customers,
    trialsUsed: async (id) => usage[id] ?? 0,
    claim: async (r: OverageRow) => {
      const existing = rows.get(r.customerId);
      if (existing) return { row: existing, claimed: false };
      const row: StoredOverageRow = { ...r, id: `row-${++seq}`, status: "pending", stripeInvoiceItemId: null };
      rows.set(r.customerId, row);
      return { row, claimed: true };
    },
    markBilled: async (id, itemId) => setStatus(id, { status: "billed", stripeInvoiceItemId: itemId }),
    markFailed: async (id) => setStatus(id, { status: "failed" }),
    createInvoiceItem: async (i) => {
      calls.push(i);
      if (failFor.has(i.stripeCustomerId)) throw new Error("stripe down");
      return { id: `ii_${calls.length}` };
    },
  };
  return { deps, calls, rows };
}

const pro = (id: string): BillableCustomer => ({ id, plan: "pro", planStatus: "active", stripeCustomerId: `cus_${id}` });

describe("billOverageForPeriod", () => {
  it("bills overage once with the expected invoice item", async () => {
    const { deps, calls } = makeDeps([pro("a")], { a: 2_812 });
    const s = await billOverageForPeriod({ period, now }, deps, "test");
    expect(s).toMatchObject({ period: "2026-10", considered: 1, billed: 1, skipped: 0, failed: 0, totalCents: 6_240 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      stripeCustomerId: "cus_a", amountCents: 6_240, idempotencyKey: "overage:a:2026-10",
      description: "Trial overage Oct 2026: 312 trials x $0.20",
      metadata: { kind: "overage", customer_id: "a", period: "2026-10", environment: "test" },
    });
  });

  it("makes no Stripe call on a second invocation", async () => {
    const { deps, calls } = makeDeps([pro("a")], { a: 3_000 });
    await billOverageForPeriod({ period, now }, deps, "test");
    const again = await billOverageForPeriod({ period, now }, deps, "test");
    expect(calls).toHaveLength(1);
    expect(again).toMatchObject({ billed: 0, skipped: 1, totalCents: 0 });
  });

  it("retries a failed charge with the same idempotency key", async () => {
    const failFor = new Set(["cus_a"]);
    const { deps, calls, rows } = makeDeps([pro("a")], { a: 2_600 }, failFor);
    const first = await billOverageForPeriod({ period, now }, deps, "test");
    expect(first).toMatchObject({ failed: 1, billed: 0 });
    expect(first.failures[0]).toMatchObject({ customerId: "a", error: "stripe down" });
    expect(rows.get("a")?.status).toBe("failed");
    failFor.clear();
    const second = await billOverageForPeriod({ period, now }, deps, "test");
    expect(second).toMatchObject({ billed: 1, failed: 0, totalCents: 2_000 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.idempotencyKey).toBe(calls[0]?.idempotencyKey);
    expect(rows.get("a")?.status).toBe("billed");
  });

  it("skips zero overage without recording a row", async () => {
    const { deps, calls, rows } = makeDeps([pro("a")], { a: 2_500 });
    const s = await billOverageForPeriod({ period, now }, deps, "test");
    expect(s).toMatchObject({ billed: 0, skipped: 1 });
    expect(calls).toHaveLength(0);
    expect(rows.size).toBe(0);
  });

  it("does not let one failure block the others", async () => {
    const { deps, calls } = makeDeps([pro("a"), pro("b"), pro("c")], { a: 2_600, b: 2_700, c: 2_800 }, new Set(["cus_b"]));
    const s = await billOverageForPeriod({ period, now }, deps, "test");
    expect(s).toMatchObject({ considered: 3, billed: 2, failed: 1, totalCents: 2_000 + 6_000 });
    expect(calls).toHaveLength(3);
  });

  it("skips developer, enterprise and lapsed subscriptions", async () => {
    const customers: BillableCustomer[] = [
      { id: "dev", plan: "developer", planStatus: null, stripeCustomerId: "cus_dev" },
      { id: "ent", plan: "enterprise", planStatus: null, stripeCustomerId: "cus_ent" },
      { id: "lapsed", plan: "pro", planStatus: "canceled", stripeCustomerId: "cus_lapsed" },
    ];
    const { deps, calls } = makeDeps(customers, { dev: 9_999, ent: 99_999, lapsed: 9_999 });
    const s = await billOverageForPeriod({ period, now }, deps, "test");
    expect(s).toMatchObject({ considered: 3, billed: 0, skipped: 3, failed: 0 });
    expect(calls).toHaveLength(0);
  });
});
