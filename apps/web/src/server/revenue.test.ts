import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const state: { where?: unknown } = {};
const result = vi.fn();
vi.mock("@ae/core/db/client", async () => {
  const schema = await import("@ae/core/db/schema");
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (w: unknown) => { state.where = w; return result(); },
  };
  return { schema, db: () => ({ select: () => chain }) };
});

import { getRevenueStats, revenueSince, DEFAULT_REVENUE_SINCE } from "./revenue";

describe("getRevenueStats", () => {
  it("filters to live, non-mock, paid/captured payments since the start date", async () => {
    result.mockResolvedValue([{ cents: "1500", jobs: "2" }]);
    const since = new Date("2026-11-07T00:00:00Z");
    const out = await getRevenueStats(since);
    expect(out).toEqual({ revenueCents: 1500, paidJobs: 2, since: since.toISOString() });
    const q = new PgDialect().sqlToQuery(state.where as never);
    expect(q.sql).toContain('"payments"."environment" = $');
    expect(q.sql).toContain('"jobs"."is_mock" = $');
    expect(q.sql).toContain('"payments"."status" in');
    expect(q.sql).toContain('"payments"."created_at" >= $');
    expect(q.params).toEqual(expect.arrayContaining(["live", false, "paid", "captured"]));
    for (const excluded of ["released", "needs_refund", "authorized", "test"]) expect(q.params).not.toContain(excluded);
    expect(q.params.some((p) => p instanceof Date || typeof p === "string" && p.startsWith("2026-11-07"))).toBe(true);
  });
  it("reports an honest zero when nothing matches", async () => {
    result.mockResolvedValue([{ cents: "0", jobs: "0" }]);
    expect(await getRevenueStats(new Date(DEFAULT_REVENUE_SINCE))).toMatchObject({ revenueCents: 0, paidJobs: 0 });
    result.mockResolvedValue([]);
    expect(await getRevenueStats()).toMatchObject({ revenueCents: 0, paidJobs: 0 });
  });
});

describe("revenueSince", () => {
  it("defaults, honours the env override, and ignores garbage", () => {
    expect(revenueSince(undefined).toISOString()).toBe("2026-11-07T00:00:00.000Z");
    expect(revenueSince("2026-12-01T00:00:00Z").toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(revenueSince("nope").toISOString()).toBe("2026-11-07T00:00:00.000Z");
  });
});
