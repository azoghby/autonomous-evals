import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@ae/core/db/client", () => ({
  db: () => ({ execute: async () => [{ query: "select 1", mean_ms: "1.234", calls: "3" }] }),
}));

import { getInfraReport } from "./infra";

describe("getInfraReport", () => {
  it("degrades per-section (no throw) when NEON_API_KEY is unset, keeping slow queries", async () => {
    const prev = process.env.NEON_API_KEY;
    delete process.env.NEON_API_KEY;
    try {
      const r = await getInfraReport();
      expect(r.neon).toBeNull();
      expect(r.neonError).toContain("NEON_API_KEY is not set");
      expect(r.slowQueriesError).toBeNull();
      expect(r.slowQueries).toEqual([{ query: "select 1", meanMs: 1.23, calls: 3 }]);
    } finally {
      if (prev !== undefined) process.env.NEON_API_KEY = prev;
    }
  });
});
