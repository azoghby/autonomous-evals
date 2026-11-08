import { beforeEach, describe, expect, it, vi } from "vitest";

const createJob = vi.fn(async (_a: unknown) => ({ jobId: "new" }));
const rateLimit = vi.fn(async (_k: string, _l: number, _w: number) => ({ ok: true, retryAfter: 0 }));
vi.mock("@/server/rate-limit", () => ({ rateLimit: (k: string, l: number, w: number) => rateLimit(k, l, w) }));
vi.mock("@/server/queries", () => ({
  getCurrentCustomer: async () => ({ id: "u1", email: "o@x.io", isOperator: false }),
  getJobForViewer: async () => ({ job: {} }),
}));
vi.mock("@/server/job-store", () => ({
  getJob: async () => ({ customerId: "u1", intake: {}, traceBlobPath: null }),
}));
vi.mock("@/server/idempotency", () => ({
  IdempotencyInProgressError: class extends Error {},
  withIdempotency: async (_k: string, fn: () => Promise<{ status: number; body: unknown }>) => fn(),
}));
vi.mock("@/server/create-job", () => ({ createJob: (a: unknown) => createJob(a) }));
vi.mock("@/server/intake", () => ({ credentialSlotsOf: () => [] }));
vi.mock("@ae/core/storage/crypto", () => ({ decryptJson: () => ({}) }));
vi.mock("@ae/core/db/client", () => ({
  schema: { jobCredentials: { jobId: "job_id" } },
  db: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) }),
}));
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));
vi.mock("@/server/http", () => ({
  jsonError: (status: number, error: string) => Response.json({ error }, { status }),
}));

import { POST } from "./route";

const post = (jobId: string, key: string) =>
  POST(new Request("http://x", { method: "POST", headers: { "idempotency-key": key } }), { params: Promise.resolve({ jobId }) });

describe("POST /api/jobs/[jobId]/retest", () => {
  beforeEach(() => vi.clearAllMocks());
  it("scopes the created job's idempotency key to the source job", async () => {
    await post("job-a", "k1");
    await post("job-b", "k1");
    const keys = createJob.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual(["retest:job-a:k1", "retest:job-b:k1"]);
  });
  it("is rate limited per customer and creates nothing when limited", async () => {
    rateLimit.mockResolvedValueOnce({ ok: false, retryAfter: 60 });
    const res = await post("job-a", "k2");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(rateLimit).toHaveBeenCalledWith("job-retest:u1", 10, 3600);
    expect(createJob).not.toHaveBeenCalled();
  });
});
