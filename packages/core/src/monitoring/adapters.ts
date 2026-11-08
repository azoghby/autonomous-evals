import type { ServiceContext } from '../contracts/services';
import type { createTextEvaluationServices } from '../evals/integration/services';
import type { createCalendarEvaluationServices } from '../evals/calendar-integration';
import type { MeasuredCost, RichEvaluationAdapter, RichRunArtifact } from './composition';

export interface ComparisonCostSnapshot {
  /** Provider-reported amounts only, uniquely keyed by source and provider operation ID. */
  costs: MeasuredCost[];
  unknownCosts: string[];
}
/** Read an authorized job-scoped ledger; do not sum estimates or infer zero from missing usage. */
export type ReadComparisonCosts = (operationId: string) => Promise<ComparisonCostSnapshot>;

/** Reuses the durable Text engine and investigator. The frozen prompt is unchanged across versions;
 * version identity comes from the trusted target resolver, never suite.versionLabel. */
export function createTextComparisonAdapter(input: {
  services: ReturnType<typeof createTextEvaluationServices>;
  ctx: ServiceContext;
  suiteDigest: string;
  readCosts: ReadComparisonCosts;
}): RichEvaluationAdapter {
  return {
    getSuite: () => input.services.getSuite(input.ctx, input.suiteDigest),
    async execute({ operationId }): Promise<RichRunArtifact> {
      const ref = { suiteDigest: input.suiteDigest, runId: operationId };
      await input.services.runSuite(input.ctx, ref);
      await input.services.investigate(input.ctx, ref);
      const report = await input.services.reportInput(input.ctx, ref);
      const costs = await input.readCosts(operationId);
      return { kind: 'text', suite: report.suite, run: report.run, investigation: report.investigation,
        limitations: report.limitations, ...costs };
    },
  };
}

/** Reuses isolated Calendar execution, durable investigation journal, and retained report evidence.
 * Branch ownership and per-version service resolvers remain the trusted application's responsibility. */
export function createCalendarComparisonAdapter(input: {
  services: ReturnType<typeof createCalendarEvaluationServices>;
  ctx: ServiceContext;
  suiteId: string;
  readCosts: ReadComparisonCosts;
}): RichEvaluationAdapter {
  return {
    getSuite: () => input.services.getSuite(input.ctx, { suiteId: input.suiteId }),
    async execute({ operationId, version }): Promise<RichRunArtifact> {
      const ref = { suiteId: input.suiteId, operationId, versionLabel: version };
      await input.services.runSuite(input.ctx, ref);
      await input.services.investigate(input.ctx, ref);
      const report = await input.services.reportInput(input.ctx, ref);
      const costs = await input.readCosts(operationId);
      return { kind: 'calendar', suite: report.suite, run: report.run, investigation: report.investigation,
        limitations: report.limitations, ...costs };
    },
  };
}

/** Bind a previously delivered authorized artifact as the monitoring baseline. No target calls.
 * Caller must resolve tenant/job/target/branch association before constructing this adapter. */
export function createRetainedComparisonAdapter(artifact: RichRunArtifact): RichEvaluationAdapter {
  const retained = structuredClone(artifact);
  return { readOnly: true, getSuite: async () => structuredClone(retained.suite),
    execute: async () => structuredClone(retained) };
}
