import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../server/monitoring", () => ({ runMonitoring: vi.fn(async () => ({ processed: 0, sent: 0, skipped: 0, errors: [] })) }));
vi.mock("../../../server/follow-ups", () => ({ runFollowUps: vi.fn(async () => ({ processed: 0, sent: 0, skipped: 0, errors: [] })) }));
import { requireCronAuth } from "./_auth";
import { GET as monitoring } from "./monitoring/route";
import { GET as followUps } from "./follow-ups/route";

const req = (auth?: string) => new Request("http://localhost/api/cron/x", { headers: auth ? { authorization: auth } : {} });

beforeEach(() => vi.stubEnv("CRON_SECRET", "s3cret"));
afterEach(() => vi.unstubAllEnvs());

describe("cron auth", () => {
  it("rejects a missing header", async () => {
    expect((await monitoring(req()))!.status).toBe(401);
  });
  it("rejects a wrong secret and a wrong scheme", async () => {
    expect((await followUps(req("Bearer nope")))!.status).toBe(401);
    expect((await followUps(req("s3cret")))!.status).toBe(401);
  });
  it("accepts the right secret", async () => {
    const res = await monitoring(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ processed: 0, sent: 0, skipped: 0, errors: [] });
  });
  it("fails closed when CRON_SECRET is unset", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(requireCronAuth(req("Bearer "))!.status).toBe(500);
  });
});
