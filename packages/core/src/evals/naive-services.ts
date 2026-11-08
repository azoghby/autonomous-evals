/** Concrete Phase 1 methods. Importing or constructing this module performs no I/O.
 * Owner composition must supply durable, currently authorized ports; this factory
 * does not configure them from env or fall back to lite when they refuse work.
 */
import type { EvalServices, ServiceContext } from '../contracts/services';
import { createNaiveDesignService, type NaiveDesignServiceDeps } from './naive-design-service';
import { createNaiveRunService, type NaiveRunServiceDeps } from './naive-run-service';
import { createNaiveInvestigationService, type NaiveInvestigationServiceDeps } from './naive-investigation-service';
import { createNaiveRerunService, type NaiveRerunServiceDeps } from './naive-rerun-service';
import { createRemediationServices, type RemediationDeps } from './remediation';
import { TrackBBlockedError } from './service-adapter';

export type NaiveMethodServices = Pick<EvalServices, 'designSuite' | 'runSuite' | 'investigate' | 'proposeAndVerifyFix' | 'rerunFinding'>;
export interface NaiveMethodServiceDeps {
  design: NaiveDesignServiceDeps;
  run: NaiveRunServiceDeps;
  investigation: NaiveInvestigationServiceDeps;
  remediation: RemediationDeps;
  rerun: NaiveRerunServiceDeps;
}
function paid(ctx: ServiceContext): void {
  if (!Number.isSafeInteger(ctx.budgetMicroUsd) || ctx.budgetMicroUsd <= 0) {
    throw new TrackBBlockedError('paused_budget', 'Naive method requires a positive authorized budget.');
  }
}
/** All five dependencies are required. Errors propagate; there is no alternate provider. */
export function createNaiveMethodServices(deps: NaiveMethodServiceDeps): NaiveMethodServices {
  const design = createNaiveDesignService(deps.design);
  const run = createNaiveRunService(deps.run);
  const investigation = createNaiveInvestigationService(deps.investigation);
  const remediation = createRemediationServices(deps.remediation);
  const rerun = createNaiveRerunService(deps.rerun);
  return {
    async designSuite(ctx, intake) { paid(ctx); return design.designSuite(ctx, intake); },
    async runSuite(ctx, suite, target, branch) { paid(ctx); return run.runSuite(ctx, suite, target, branch); },
    async investigate(ctx, suite, runs) { paid(ctx); return investigation.investigate(ctx, suite, runs); },
    async proposeAndVerifyFix(ctx, input) { paid(ctx); return remediation.proposeAndVerifyFix(ctx, input); },
    async rerunFinding(ctx, finding, scenario) { paid(ctx); return rerun.rerunFinding(ctx, finding, scenario); },
  };
}
