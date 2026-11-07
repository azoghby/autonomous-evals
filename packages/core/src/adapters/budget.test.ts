import { describe, expect, it, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../db/client", () => ({ db: () => ({ execute }) }));

import { createBudgetReserver } from "./budget";

const dialect = new PgDialect();
beforeEach(() => execute.mockReset());

describe("budget reserver", () => {
  it("reserve issues one insert-select guarded by remaining >= amount and returns the id", async () => {
    execute.mockResolvedValueOnce({ rows: [{ reservation_id: "res1", remaining: "900" }] });
    const r = await createBudgetReserver("j1").reserve("engineer", 500);
    expect(r).toEqual({ ok: true, reservationId: "res1" });
    expect(execute).toHaveBeenCalledTimes(1);
    const q = dialect.sqlToQuery(execute.mock.calls[0]![0]);
    expect(q.sql).toMatch(/insert into budget_reservations/);
    expect(q.sql).toMatch(/where remaining >= \$\d+::bigint/);
    expect(q.sql).toMatch(/released_at is null/);
    expect(q.sql).toMatch(/from costs/);
    expect(q.params).toEqual(expect.arrayContaining(["j1", "engineer", 500, "trace_audit", 3_000_000]));
  });

  it("refuses when over budget and reports what remains", async () => {
    execute.mockResolvedValueOnce({ rows: [{ reservation_id: null, remaining: "120" }] });
    expect(await createBudgetReserver("j1").reserve("engineer", 500)).toEqual({ ok: false, remainingMicroUsd: 120 });
  });

  it("reports zero remaining for unknown jobs and clamps negatives", async () => {
    execute.mockResolvedValueOnce({ rows: [{ reservation_id: null, remaining: null }] });
    expect(await createBudgetReserver("x").reserve("a", 1)).toEqual({ ok: false, remainingMicroUsd: 0 });
    execute.mockResolvedValueOnce({ rows: [{ reservation_id: null, remaining: "-50" }] });
    expect(await createBudgetReserver("x").reserve("a", 1)).toEqual({ ok: false, remainingMicroUsd: 0 });
  });

  it("rejects non-positive or fractional amounts without touching the db", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) await expect(createBudgetReserver("j1").reserve("a", bad)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("release only touches unreleased rows of this job (idempotent) and never throws on repeats", async () => {
    execute.mockResolvedValue({ rows: [] });
    const b = createBudgetReserver("j1");
    await b.release("res1");
    await b.release("res1");
    const q = dialect.sqlToQuery(execute.mock.calls[0]![0]);
    expect(q.sql).toMatch(/set released_at = now\(\)/);
    expect(q.sql).toMatch(/released_at is null/);
    expect(q.params).toEqual(["res1", "j1"]);
  });
});
