import { describe, expect, it, vi } from "vitest";
import type { ServiceContext } from "../contracts/services";
import { TrackBBlockedError } from "../evals/service-adapter";
import { assertPaidBudget, composeEvalServices, EvalServiceUnavailableError, type BranchServices } from "./compose";
import { evalServices, EvalServiceConfigError, missingRealServiceEnv, NAIVE_AGENT_ENV, trackBDatabaseUrl } from "./eval-services";

const ctx: ServiceContext = {
  jobId: "job-1", environment: "test", budgetMicroUsd: 1_000_000,
  recordCost: async () => {}, recordProgress: async () => {},
};

const fakeBranches = (): BranchServices => ({
  createJobBranch: vi.fn(async () => ({ branchId: "br-1", connectionString: "postgres://x" })),
  deleteJobBranch: vi.fn(async () => {}),
  getJobBranchConnection: vi.fn(async () => "postgres://x"),
});

describe("composeEvalServices", () => {
  it("throws EvalServiceUnavailableError for contract methods Track B has not implemented", async () => {
    const s = composeEvalServices({ agents: async () => { throw new Error("unused"); }, branches: async () => fakeBranches() });
    for (const call of [
      () => s.designSuite(ctx, { package: "trace_audit", trace: "x" } as never),
      () => s.runSuite(ctx, {} as never, { url: "", model: "", systemPrompt: "" }),
      () => s.investigate(ctx, {} as never, []),
      () => s.proposeAndVerifyFix(ctx, {} as never),
      () => s.rerunFinding(ctx, {} as never, undefined),
    ]) {
      expect(call).toThrow(EvalServiceUnavailableError);
    }
  });

  it("delegates branch methods and builds branch services once", async () => {
    const branches = fakeBranches();
    const factory = vi.fn(async () => branches);
    const s = composeEvalServices({ agents: async () => { throw new Error("unused"); }, branches: factory });
    await expect(s.createJobBranch("job-1")).resolves.toEqual({ branchId: "br-1", connectionString: "postgres://x" });
    await s.deleteJobBranch("br-1");
    await expect(s.getJobBranchConnection!("br-1")).resolves.toBe("postgres://x");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("retries configuration after a failed factory instead of caching the failure", async () => {
    const factory = vi.fn().mockRejectedValueOnce(new Error("not configured")).mockResolvedValue(fakeBranches());
    const s = composeEvalServices({ agents: async () => { throw new Error("unused"); }, branches: factory });
    await expect(s.deleteJobBranch("br-1")).rejects.toThrow("not configured");
    await expect(s.deleteJobBranch("br-1")).resolves.toBeUndefined();
  });

  it("rejects a blocked target URL via Track B's transport without configuration", async () => {
    const s = composeEvalServices({ agents: async () => { throw new Error("unused"); }, branches: async () => fakeBranches() });
    const r = await s.checkTarget(ctx, { url: "http://127.0.0.1/v1/chat/completions", model: "m" });
    expect(r.ok).toBe(false);
  });
});

describe("budget-0 refusal", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses paid methods with budget %s before building agent services", async (budgetMicroUsd) => {
    const agents = vi.fn(async () => { throw new Error("must not be built"); });
    const recordCost = vi.fn(async () => {});
    const c: ServiceContext = { ...ctx, budgetMicroUsd, recordCost };
    const s = composeEvalServices({ agents, branches: async () => fakeBranches() });
    for (const call of [
      () => s.qualify(c, { package: "trace_audit", trace: "x" } as never, []),
      () => s.auditTrace(c, "trace"),
      () => s.renderReport(c, { intake: { package: "trace_audit", trace: "x" } as never, findings: [] }),
    ]) {
      const err = await call().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(TrackBBlockedError);
      expect((err as TrackBBlockedError).code).toBe("paused_budget");
      expect((err as Error).message).toMatch(/budget/i);
    }
    expect(agents).not.toHaveBeenCalled();
    expect(recordCost).not.toHaveBeenCalled();
  });

  it("lets a positive budget through to agent services", async () => {
    expect(() => assertPaidBudget(ctx, "qualify")).not.toThrow();
    const agents = vi.fn(async () => { throw new Error("built"); });
    const s = composeEvalServices({ agents, branches: async () => fakeBranches() });
    await expect(s.qualify(ctx, { package: "trace_audit", trace: "x" } as never, [])).rejects.toThrow("built");
    expect(agents).toHaveBeenCalledTimes(1);
  });

  it("does not gate free branch/target methods on budget", async () => {
    const zero: ServiceContext = { ...ctx, budgetMicroUsd: 0 };
    const s = composeEvalServices({ agents: async () => { throw new Error("unused"); }, branches: async () => fakeBranches() });
    await expect(s.deleteJobBranch("br-1")).resolves.toBeUndefined();
    expect((await s.checkTarget(zero, { url: "http://127.0.0.1/v1/chat/completions", model: "m" })).ok).toBe(false);
  });
});

describe("env-configured evalServices", () => {
  it("reports missing env var names (never values)", () => {
    const m = missingRealServiceEnv({ DATABASE_URL: "postgres://u:p@h/db" });
    expect(m.agents).toEqual(["NAIVE_API_KEY", ...Object.values(NAIVE_AGENT_ENV)]);
    expect(m.branches).toEqual(["NEON_API_KEY", "NEON_PROJECT_ID", "NEON_SIM_SEED_BRANCH_ID"]);
  });

  it("prefers the unpooled endpoint for Track B session-lock pools", () => {
    expect(trackBDatabaseUrl({ DATABASE_URL: "postgres://a-pooler/db", DATABASE_URL_UNPOOLED: "postgres://a/db" })).toBe("postgres://a/db");
    expect(trackBDatabaseUrl({ DATABASE_URL: "postgres://a-pooler/db", DATABASE_URL_UNPOOLED: " " })).toBe("postgres://a-pooler/db");
  });

  it("fails agent calls with EvalServiceConfigError when Naïve is not configured", async () => {
    vi.stubEnv("NAIVE_API_KEY", "");
    try {
      await expect(evalServices.qualify(ctx, { package: "trace_audit", trace: "x" } as never, [])).rejects.toBeInstanceOf(EvalServiceConfigError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
