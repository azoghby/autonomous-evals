import { describe, expect, it, vi } from "vitest";
import { applyBranchTtl, branchExpiry } from "./ttl";
import type { NeonClient } from "./api";

const delivered = new Date("2026-11-07T12:00:00Z");
const fake = () => ({ setBranchExpiration: vi.fn(async () => ({ id: "b", name: "b" })) }) as unknown as NeonClient & { setBranchExpiration: ReturnType<typeof vi.fn> };

describe("branch TTL", () => {
  it("is deliveredAt + 7 days", () => {
    expect(branchExpiry(delivered).toISOString()).toBe("2026-11-14T12:00:00.000Z");
  });
  it("sets expires_at on the branch", async () => {
    const c = fake();
    const at = await applyBranchTtl("br-1", delivered, c, delivered);
    expect(at.toISOString()).toBe("2026-11-14T12:00:00.000Z");
    expect(c.setBranchExpiration).toHaveBeenCalledWith("br-1", at);
  });
  it("rejects an expiry already in the past", async () => {
    const c = fake();
    await expect(applyBranchTtl("br-1", delivered, c, new Date("2026-12-01T00:00:00Z"))).rejects.toThrow(/past/);
    expect(c.setBranchExpiration).not.toHaveBeenCalled();
  });
});
