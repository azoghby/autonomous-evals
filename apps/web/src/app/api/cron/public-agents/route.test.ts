import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const run = vi.hoisted(() => vi.fn(async () => ({ status: "skipped", reason: "nothing_due" })));
vi.mock("@/server/public-agent-cron", () => ({ runNextPublicAgent: run }));
import { GET } from "./route";

const req = (auth?: string) => new Request("http://localhost/api/cron/public-agents", { headers: auth ? { authorization: auth } : {} });
beforeEach(() => { vi.stubEnv("CRON_SECRET", "s3cret"); run.mockClear(); });
afterEach(() => vi.unstubAllEnvs());

describe("public-agents cron route", () => {
  it("401 without or with a wrong secret, and never runs", async () => {
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer nope"))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it("runs a tick with the right secret", async () => {
    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "skipped", reason: "nothing_due" });
  });
});
