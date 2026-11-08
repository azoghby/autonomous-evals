import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(), lock: vi.fn(), exposure: vi.fn(),
  reserve: vi.fn(), stage: vi.fn(), dispatched: vi.fn(), releaseHold: vi.fn(),
}));
vi.mock("@neondatabase/serverless", () => ({ Pool: class {
  async connect() { return { query: mocks.query, release: mocks.release }; }
} }));
vi.mock("../db/job-budget-authority", () => ({
  lockJobBudget: mocks.lock, jobBudgetExposure: mocks.exposure,
  reserveJobBudget: mocks.reserve, reserveWorkflowJobBudget: mocks.stage,
  markJobBudgetDispatched: mocks.dispatched, releaseWorkflowJobBudget: mocks.releaseHold,
}));
import { createBudgetReserver, reserveWorkflowBudget } from "./budget";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://offline.invalid/test");
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.exposure.mockResolvedValue({ capMicroUsd: 3_000_000, committedMicroUsd: 0, remainingMicroUsd: 3_000_000 });
});

describe("shared production budget adapter", () => {
  it("takes the canonical lock and derives stage allowance from the database cap", async () => {
    mocks.stage.mockResolvedValue({ ok: true, reservationId: "stage" });
    expect(await reserveWorkflowBudget("job", "engineer", .25)).toEqual({ ok: true, reservationId: "stage", amountMicroUsd: 750_000 });
    expect(mocks.query.mock.calls.map(c => c[0])).toEqual(["BEGIN ISOLATION LEVEL READ COMMITTED", "COMMIT"]);
    expect(mocks.lock).toHaveBeenCalledWith(expect.anything(), "job");
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.exposure.mock.invocationCallOrder[0]!);
    expect(mocks.stage).toHaveBeenCalledWith(expect.anything(), { jobId: "job", agent: "engineer", amountMicroUsd: 750_000 });
  });
  it("routes legacy extra reservations through the same authority and marks dispatch before commit", async () => {
    mocks.reserve.mockResolvedValue({ ok: true, reservationId: "extra" });
    expect(await createBudgetReserver("job").reserve("judge", 500)).toEqual({ ok: true, reservationId: "extra" });
    const operation = mocks.reserve.mock.calls[0]![1];
    expect(operation).toMatchObject({ jobId: "job", amountMicroUsd: 500, workflowAgent: "judge" });
    expect(operation.operationId).toMatch(/^adapter:/);
    expect(mocks.dispatched).toHaveBeenCalledWith(expect.anything(), "job", operation.operationId);
    expect(mocks.dispatched.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[1]!);
  });
  it("returns denial without dispatch or release", async () => {
    mocks.reserve.mockResolvedValue({ ok: false, remainingMicroUsd: 120 });
    expect(await createBudgetReserver("job").reserve("judge", 500)).toEqual({ ok: false, remainingMicroUsd: 120 });
    expect(mocks.dispatched).not.toHaveBeenCalled();
    expect(mocks.releaseHold).not.toHaveBeenCalled();
  });
  it("rejects invalid amounts before connecting", async () => {
    for (const amount of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(createBudgetReserver("job").reserve("judge", amount)).rejects.toThrow();
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("holds on ambiguous commit and never replays admission or releases it", async () => {
    mocks.reserve.mockResolvedValue({ ok: true, reservationId: "extra" });
    mocks.query.mockImplementation(async (text: string) => { if (text === "COMMIT") throw new Error("lost acknowledgement"); return { rows: [] }; });
    await expect(createBudgetReserver("job").reserve("judge", 500)).rejects.toThrow("lost acknowledgement");
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.releaseHold).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ message: "budget_commit_uncertain" }));
  });
  it("releases only through shared authority in a transaction", async () => {
    await createBudgetReserver("job").release("extra");
    expect(mocks.releaseHold).toHaveBeenCalledWith(expect.anything(), "job", "extra");
    expect(mocks.query.mock.calls.map(c => c[0])).toEqual(["BEGIN ISOLATION LEVEL READ COMMITTED", "COMMIT"]);
  });
});
