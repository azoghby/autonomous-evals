import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({ rows: [] as unknown[], wheres: [] as unknown[], updates: 0 }));

vi.mock("server-only", () => ({}));
vi.mock("./job-store", () => ({ recordProgress: vi.fn() }));
vi.mock("@ae/core/db/client", async () => {
  const schema = await import("@ae/core/db/schema");
  const chain = (rows: () => unknown[]) => {
    const c: Record<string, unknown> = {
      innerJoin: () => c, from: () => c, values: () => c, onConflictDoNothing: () => c, limit: () => c, set: () => c, returning: () => c,
      where: (w: unknown) => { h.wheres.push(w); return c; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(rows()).then(res, rej),
    };
    return c;
  };
  return {
    schema,
    db: () => ({
      select: () => chain(() => h.rows),
      update: () => chain(() => { h.updates++; return []; }),
      insert: () => chain(() => []),
    }),
  };
});

import { getQuestionnaire, optOut, submitAnswers } from "./experts";

const dialect = new PgDialect();
const future = new Date(Date.now() + 86_400_000);
const engagement = (mode: string) => ({
  engagement: { id: "e1", mode, status: "invited", expiresAt: future, honorariumCents: 5000 },
  request: { id: "r1", domain: "law", purpose: "p", questions: ["q1", "q2"], jobId: null },
});

beforeEach(() => { h.rows = []; h.wheres = []; h.updates = 0; });

describe("call-mode engagements get the booking page only", () => {
  it("getQuestionnaire returns mode=call with no questions", async () => {
    h.rows = [engagement("call")];
    const r = await getQuestionnaire("tok");
    expect(r).toMatchObject({ check: "ok", questionnaire: { mode: "call", questions: [] } });
  });
  it("getQuestionnaire still returns the questions for async", async () => {
    h.rows = [engagement("async")];
    const r = await getQuestionnaire("tok");
    expect(r).toMatchObject({ check: "ok", questionnaire: { mode: "async", questions: ["q1", "q2"] } });
  });
  it("submitAnswers rejects call-mode with 409 and writes nothing", async () => {
    h.rows = [engagement("call")];
    const r = await submitAnswers("tok", [{ questionIndex: 0, answer: "a" }]);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(h.updates).toBe(0);
  });
});

describe("optOut token matching", () => {
  it("also matches previously rotated token hashes", async () => {
    h.rows = [{ email: "dana@example.com" }];
    await optOut({ token: "old-token" });
    const q = dialect.sqlToQuery(h.wheres[0] as never);
    expect(q.sql).toMatch(/"token_hash" = \$\d+/);
    expect(q.sql).toMatch(/= any\("expert_engagements"\."previous_token_hashes"\)/);
  });
});
