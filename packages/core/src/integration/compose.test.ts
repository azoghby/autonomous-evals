import { describe, expect, it, vi } from "vitest";
import type { ServiceContext } from "../contracts/services";
import { composeEvalServices, EvalServiceUnavailableError, type BranchServices } from "./compose";
import { evalServices, EvalServiceConfigError, missingRealServiceEnv, NAIVE_AGENT_ENV } from "./eval-services";

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

describe("env-configured evalServices", () => {
  it("reports missing env var names (never values)", () => {
    const m = missingRealServiceEnv({ DATABASE_URL: "postgres://u:p@h/db" });
    expect(m.agents).toEqual(["NAIVE_API_KEY", ...Object.values(NAIVE_AGENT_ENV)]);
    expect(m.branches).toEqual(["NEON_API_KEY", "NEON_PROJECT_ID", "NEON_SIM_SEED_BRANCH_ID"]);
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
