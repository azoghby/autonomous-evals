/**
 * Lite engine (EVAL_SERVICES=lite): full EvalServices over the AI gateway + Track B's SSRF-safe target transport.
 * No Naive agents, no Neon branching. Importing has no side effects; network only when a method runs.
 */
import type { EvalServices } from "../contracts/services";
import { defaultLiteDeps, LiteUnavailableError, TargetRegistry, type LiteDeps } from "./deps";
import { createRunServices } from "./run";
import { createDesignServices } from "./design";
import { createInvestigateServices } from "./investigate";

export { LiteUnavailableError, TargetRegistry, defaultLiteDeps, resolveLiteTarget } from "./deps";
export type { LiteDeps, LiteTarget } from "./deps";

/** Branch ids the lite engine hands out; it has no isolated database, so they are inert placeholders. */
export const LITE_BRANCH_PREFIX = "lite-nobranch-";
/** Inert placeholder "connection string": lite runSuite ignores branchConnString. Not a secret. */
export const LITE_NO_DATABASE = "lite://no-database";

export function createLiteServices(overrides: Partial<LiteDeps> = {}, registry: TargetRegistry = new TargetRegistry()): EvalServices {
  const deps = defaultLiteDeps(overrides);
  const run = createRunServices(deps, registry);
  // Fix verification re-runs exact before/after sets; in-run reproduction would only add cost there.
  const verifyRun = createRunServices(deps, registry, { reproduce: false });
  const design = createDesignServices(deps);
  const investigate = createInvestigateServices(deps, registry, verifyRun.runSuite);
  return {
    qualify: design.qualify,
    auditTrace: design.auditTrace,
    designSuite: design.designSuite,
    renderReport: design.renderReport,
    checkTarget: run.checkTarget,
    runSuite: run.runSuite,
    rerunFinding: run.rerunFinding,
    investigate: investigate.investigate,
    proposeAndVerifyFix: investigate.proposeAndVerifyFix,
    // Workflow evals call createJobBranch unconditionally; lite runs targets without a simulated DB.
    async createJobBranch(jobId) {
      return { branchId: `${LITE_BRANCH_PREFIX}${jobId}`, connectionString: LITE_NO_DATABASE };
    },
    async deleteJobBranch(branchId) {
      if (!branchId.startsWith(LITE_BRANCH_PREFIX)) throw new LiteUnavailableError("deleteJobBranch", `not a lite branch: ${branchId.slice(0, 80)}`);
    },
    async getJobBranchConnection(branchId) {
      if (!branchId.startsWith(LITE_BRANCH_PREFIX)) throw new LiteUnavailableError("getJobBranchConnection", "not a lite branch");
      return LITE_NO_DATABASE;
    },
  };
}

let shared: EvalServices | undefined;
/** Process-wide lite services (shared TargetRegistry). */
export function liteServices(): EvalServices {
  shared ??= createLiteServices();
  return shared;
}
