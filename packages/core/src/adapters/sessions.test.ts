import { describe, expect, it, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => {
  const returning = vi.fn();
  const chain: Record<string, any> = {};
  for (const k of ["insert", "values", "onConflictDoNothing", "select", "from", "where", "orderBy", "update", "set"]) chain[k] = vi.fn(() => chain);
  chain.returning = returning;
  chain.limit = vi.fn();
  return { chain, returning };
});
vi.mock("../db/client", async () => ({ db: () => h.chain, schema: (await vi.importActual<typeof import("../db/schema")>("../db/schema")) }));

import { createSessionStore } from "./sessions";

const row = (o: object = {}) => ({ id: "r1", jobId: "j1", agent: "a", agentId: null, agentVersion: null, sessionId: "s1", status: "created", decision: null, result: null, usageMicroUsd: 0, ...o });
const dialect = new PgDialect();

beforeEach(() => { vi.clearAllMocks(); });

describe("session store", () => {
  it("start inserts with ON CONFLICT DO NOTHING and returns the new row", async () => {
    h.returning.mockResolvedValueOnce([row()]);
    const r = await createSessionStore("j1").start({ agent: "a", sessionId: "s1" });
    expect(h.chain.onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(r.sessionId).toBe("s1");
    expect(h.chain.limit).not.toHaveBeenCalled();
  });

  it("start is idempotent: on conflict it returns the existing row", async () => {
    h.returning.mockResolvedValueOnce([]);
    h.chain.limit.mockResolvedValueOnce([row({ status: "running" })]);
    const r = await createSessionStore("j1").start({ agent: "a", sessionId: "s1" });
    expect(r.status).toBe("running");
  });

  it("start refuses a sessionId owned by another job", async () => {
    h.returning.mockResolvedValueOnce([]);
    h.chain.limit.mockResolvedValueOnce([]);
    await expect(createSessionStore("j1").start({ agent: "a", sessionId: "s1" })).rejects.toThrow(/another job/);
  });

  it("update increments usage atomically in SQL (col = col + n) in a single UPDATE", async () => {
    h.returning.mockResolvedValueOnce([row({ usageMicroUsd: 5 })]);
    await createSessionStore("j1").update("s1", { status: "running", addUsageMicroUsd: 5 });
    expect(h.chain.update).toHaveBeenCalledTimes(1);
    const set = h.chain.set.mock.calls[0]![0];
    expect(set.status).toBe("running");
    const q = dialect.sqlToQuery(set.usageMicroUsd);
    expect(q.sql).toMatch(/"usage_micro_usd" \+ \$1/);
    expect(q.params).toEqual([5]);
  });

  it("update rejects negative / fractional usage and returns null for unknown sessions", async () => {
    await expect(createSessionStore("j1").update("s1", { addUsageMicroUsd: -1 })).rejects.toThrow();
    await expect(createSessionStore("j1").update("s1", { addUsageMicroUsd: 1.5 })).rejects.toThrow();
    h.returning.mockResolvedValueOnce([]);
    expect(await createSessionStore("j1").update("nope", { status: "x" })).toBeNull();
  });

  it("findResumable excludes terminal statuses in the query and returns null when none", async () => {
    h.chain.limit.mockResolvedValueOnce([]);
    expect(await createSessionStore("j1").findResumable("a")).toBeNull();
    const cond = dialect.sqlToQuery(h.chain.where.mock.calls[0]![0]);
    expect(cond.sql).toMatch(/not in/i);
    expect(cond.params).toEqual(expect.arrayContaining(["j1", "a", "completed", "failed", "cancelled"]));
  });

  it("findResumable returns the latest non-terminal session", async () => {
    h.chain.limit.mockResolvedValueOnce([row({ status: "running" })]);
    expect((await createSessionStore("j1").findResumable("a"))?.status).toBe("running");
  });
});
