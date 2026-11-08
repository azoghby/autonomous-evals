import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), drain: vi.fn(), candidates: vi.fn(), process: vi.fn(), where: vi.fn() }));
vi.mock("../_auth", () => ({ requireCronAuth: mocks.auth }));
vi.mock("@/server/job-cancellation-delivery", () => ({ drainJobCancellations: mocks.drain }));
vi.mock("../../../../server/stale-jobs", () => ({ processStaleJobs: mocks.process }));
vi.mock("./recovery", () => ({ loadCandidates: mocks.candidates, staleJobDeps: {} }));
vi.mock("@ae/core/db/client", () => ({ db: () => ({ select: () => ({ from: () => ({ where: mocks.where }) }) }),
  schema: { payments: { id: "id", jobId: "job", createdAt: "created", status: "status" } } }));
import { GET } from "./route";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockReturnValue(null); mocks.drain.mockResolvedValue({ attempted: 1, errors: [] });
  mocks.candidates.mockResolvedValue([]); mocks.process.mockResolvedValue({ errors: [] }); mocks.where.mockResolvedValue([]);
});
it("drains cancellation outbox even with no stale lifecycle candidates", async () => {
  const response = await GET(new Request("https://example.test"));
  expect(response.status).toBe(200);
  expect(mocks.drain).toHaveBeenCalledTimes(1);
  expect((await response.json()).cancellations.attempted).toBe(1);
});
it("retains retry failures in cron response", async () => {
  mocks.drain.mockResolvedValue({ attempted: 1, errors: ["job:workflow_notification_pending"] });
  expect((await GET(new Request("https://example.test"))).status).toBe(500);
});
it("authenticates before attempting cancellation delivery", async () => {
  mocks.auth.mockReturnValue(new Response(null, { status: 401 }));
  expect((await GET(new Request("https://example.test"))).status).toBe(401);
  expect(mocks.drain).not.toHaveBeenCalled();
});
