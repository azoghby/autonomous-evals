import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ reserve: vi.fn(), release: vi.fn(), job: vi.fn(), context: vi.fn() }));
vi.mock("workflow", () => ({ FatalError: class extends Error {} }));
vi.mock("@ae/core/adapters/budget", () => ({ reserveWorkflowBudget: mocks.reserve, releaseWorkflowBudget: mocks.release }));
vi.mock("@/server/job-store", () => ({ getJob: mocks.job, makeServiceContext: mocks.context, getJobWithDecryptedCredentials: vi.fn() }));
import { withBudget } from "./common";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.job.mockResolvedValue({ id: "job", package: "trace_audit" });
  mocks.context.mockResolvedValue({ jobId: "job", budgetMicroUsd: 3_000_000 });
  mocks.reserve.mockResolvedValue({ ok: true, reservationId: "stage", amountMicroUsd: 750_000 });
});
describe("whole Workflow stage shared budget", () => {
  it("runs the whole callback under its admitted allowance and releases after success", async () => {
    const events: string[] = [];
    mocks.release.mockImplementation(async () => { events.push("release"); });
    const result = await withBudget("job", "engineer", async ctx => {
      expect(ctx.budgetMicroUsd).toBe(750_000);
      events.push("call one", "call two", "cost persisted");
      return "done";
    });
    expect(result).toEqual({ status: "ok", data: "done" });
    expect(mocks.reserve).toHaveBeenCalledWith("job", "engineer", .25);
    expect(events).toEqual(["call one", "call two", "cost persisted", "release"]);
    expect(mocks.release).toHaveBeenCalledWith("job", "stage");
  });
  it("does not invoke service or release on denial", async () => {
    mocks.reserve.mockResolvedValue({ ok: false, remainingMicroUsd: 4 });
    const run = vi.fn();
    expect(await withBudget("job", "engineer", run)).toMatchObject({ status: "budget_exceeded" });
    expect(run).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it("preserves failed or uncertain stage holds, including context construction failure", async () => {
    await expect(withBudget("job", "judge", async () => { throw new Error("unknown provider outcome"); })).rejects.toThrow("unknown provider outcome");
    mocks.context.mockRejectedValue(new Error("context unavailable"));
    await expect(withBudget("job", "judge", vi.fn())).rejects.toThrow("context unavailable");
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it("retains the same returned reservation on retry and surfaces release uncertainty", async () => {
    mocks.release.mockRejectedValue(new Error("commit uncertain"));
    await expect(withBudget("job", "engineer", async () => "done")).rejects.toThrow("commit uncertain");
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
  });
  it("requires an existing job before admission", async () => {
    mocks.job.mockResolvedValue(null);
    await expect(withBudget("missing", "engineer", vi.fn())).rejects.toThrow("not found");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});
