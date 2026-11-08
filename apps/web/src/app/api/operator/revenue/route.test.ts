import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentCustomer = vi.fn();
vi.mock("@/server/queries", () => ({ getCurrentCustomer: () => getCurrentCustomer() }));
vi.mock("@/server/revenue-metrics", () => ({ getRevenueMetrics: vi.fn(async () => ({ generatedAt: "t", stripeMode: "test" })) }));

import { GET } from "./route";
import { getRevenueMetrics } from "@/server/revenue-metrics";

describe("GET /api/operator/revenue", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401 when signed out", async () => {
    getCurrentCustomer.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(getRevenueMetrics).not.toHaveBeenCalled();
  });
  it("403 for non-operators", async () => {
    getCurrentCustomer.mockResolvedValue({ id: "c", email: "a@b.c", isOperator: false });
    expect((await GET()).status).toBe(403);
    expect(getRevenueMetrics).not.toHaveBeenCalled();
  });
  it("200 for operators", async () => {
    getCurrentCustomer.mockResolvedValue({ id: "c", email: "a@b.c", isOperator: true });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
