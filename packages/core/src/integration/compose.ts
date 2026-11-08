/**
 * Composes Track B engine pieces into Track A's `EvalServices` contract.
 *
 * Wired today:
 *   - qualify / auditTrace / renderReport  -> evals/service-adapter.ts (Naïve agent sessions)
 *   - checkTarget                          -> targets/adapters.ts (SSRF-safe HTTPS transport)
 *   - create/delete/getJobBranchConnection -> simulator/adapters.ts (+ Neon connection resolver)
 *
 * Not yet wired (throw `EvalServiceUnavailableError`, never a fabricated result):
 *   - designSuite / runSuite / investigate: Track B's text engine (evals/integration) has a richer,
 *     digest-addressed API (FrozenTextSuite, SuiteRun) that needs a contract mapping plus the
 *     unapplied `evals/integration/migrations/001-text-integration.sql` checkpoint table.
 *   - proposeAndVerifyFix: no verified-remediation engine exists in Track B (docs/TRACK_B_INTEGRATION.md).
 *   - rerunFinding: needs authorized frozen state/credentials from durable storage.
 */
import type { EvalServices, ServiceContext } from "../contracts/services";
import { createTrackBServices, TrackBBlockedError, type TrackBServiceDeps } from "../evals/service-adapter";
import { createTargetServices } from "../targets/adapters";
import type { createBranchServices } from "../simulator/adapters";

/** A contract method Track B has not implemented (or that is not configured). Never retry automatically. */
export class EvalServiceUnavailableError extends Error {
  readonly retryable = false;
  constructor(readonly method: string, readonly reason: string) {
    super(`EvalServices.${method} is unavailable: ${reason}`);
    this.name = "EvalServiceUnavailableError";
  }
}

/**
 * Budget-0 refusal (LEDGER §5 NO-GO 3). Track B's adapter treats `ctx.budgetMicroUsd` as information only,
 * so the seam refuses any paid (Naïve-backed) method when the job has no budget left, before agent services
 * are even built: no session, reservation or cost row. A typed, non-retryable `paused_budget` block, so
 * Track A maps it to FatalError and never falls back to the (also paid) lite engine.
 */
export function assertPaidBudget(ctx: ServiceContext, method: string): void {
  const budget = ctx.budgetMicroUsd;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    throw new TrackBBlockedError("paused_budget", `EvalServices.${method} refused: job budget is ${Number.isFinite(budget) ? budget : "invalid"} micro-USD (no paid calls with zero budget)`);
  }
}

export type BranchServices = ReturnType<typeof createBranchServices>;

export interface ComposeEvalServicesDeps {
  /** Lazily built agent-backed services (needs Naïve + PostgreSQL agent persistence). */
  agents: () => Promise<TrackBServiceDeps>;
  /** Lazily built branch services (needs Neon API + branch ownership ledger). */
  branches: () => Promise<BranchServices>;
  /** Defaults to the real HTTPS transport. */
  targets?: ReturnType<typeof createTargetServices>;
}

const unavailable = (method: string, reason: string) => (): never => {
  throw new EvalServiceUnavailableError(method, reason);
};

const TEXT_ENGINE_GAP = "Track B text-eval engine is not yet mapped to the EvalServices contract (see docs/INTEGRATION.md)";

export function composeEvalServices(deps: ComposeEvalServicesDeps): EvalServices {
  const targets = deps.targets ?? createTargetServices();
  let agentServices: Promise<ReturnType<typeof createTrackBServices>> | undefined;
  const agents = () => {
    agentServices ??= deps.agents().then(createTrackBServices).catch((error: unknown) => {
      agentServices = undefined; // allow a later call to retry configuration
      throw error;
    });
    return agentServices;
  };
  let branchServices: Promise<BranchServices> | undefined;
  const branches = () => {
    branchServices ??= deps.branches().catch((error: unknown) => {
      branchServices = undefined;
      throw error;
    });
    return branchServices;
  };

  return {
    async qualify(ctx, intake, clarifications) { assertPaidBudget(ctx, "qualify"); return (await agents()).qualify(ctx, intake, clarifications); },
    async auditTrace(ctx, trace, systemPrompt) { assertPaidBudget(ctx, "auditTrace"); return (await agents()).auditTrace(ctx, trace, systemPrompt); },
    async renderReport(ctx, input) { assertPaidBudget(ctx, "renderReport"); return (await agents()).renderReport(ctx, input); },
    async checkTarget(ctx: ServiceContext, endpoint) { return targets.checkTarget(ctx, endpoint); },
    async createJobBranch(jobId) { return (await branches()).createJobBranch(jobId); },
    async deleteJobBranch(branchId) { return (await branches()).deleteJobBranch(branchId); },
    async getJobBranchConnection(branchId) { return (await branches()).getJobBranchConnection(branchId); },
    designSuite: unavailable("designSuite", TEXT_ENGINE_GAP),
    runSuite: unavailable("runSuite", TEXT_ENGINE_GAP),
    investigate: unavailable("investigate", TEXT_ENGINE_GAP),
    proposeAndVerifyFix: unavailable("proposeAndVerifyFix", "Track B has no verified-remediation engine yet"),
    rerunFinding: unavailable("rerunFinding", "rerun needs frozen state/credentials resolved from durable job storage"),
  };
}
