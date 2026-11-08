import { describe, expect, it, vi } from "vitest";

const claimed = new Set<string>();
vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", () => ({ eq: (_c: unknown, v: string) => v }));
vi.mock("@ae/core/db/client", () => ({
  schema: { idempotencyKeys: { key: "key" } },
  db: () => ({
    insert: () => ({ values: (v: { key: string }) => ({ onConflictDoNothing: () => ({ returning: async () => {
      if (claimed.has(v.key)) return [];
      claimed.add(v.key);
      return [{ key: v.key }];
    } }) }) }),
    delete: () => ({ where: async (key: string) => { claimed.delete(key); } }),
  }),
}));

import { claimRerunSlot, releaseRerunSlot } from "./rerun-slots";

describe("claimRerunSlot", () => {
  it("grants at most 3 slots even under concurrency, then refuses", async () => {
    claimed.clear();
    const results = await Promise.all(Array.from({ length: 6 }, () => claimRerunSlot("f1")));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(new Set(results.filter(Boolean)).size).toBe(3);
    expect(await claimRerunSlot("f1")).toBeNull();
  });
  it("frees a slot on release", async () => {
    claimed.clear();
    const keys = [await claimRerunSlot("f2"), await claimRerunSlot("f2"), await claimRerunSlot("f2")];
    expect(await claimRerunSlot("f2")).toBeNull();
    await releaseRerunSlot(keys[1]!);
    expect(await claimRerunSlot("f2")).toBe(keys[1]);
  });
});
