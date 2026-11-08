import type { ServiceContext } from '../../contracts/services';
import { containsSecret } from '../../agents/redact';
import type { JobRef } from '../types';
import type { DataOrchestrationResult } from '../data/orchestration';
import { frozenDataReference, type DataDesignContext, type DataReferenceProvenance } from '../data/adapters/mapping';
import { canonicalJson, verifyAdmittedFrozenSuite } from '../text/freeze';
import type { FrozenTextSuite } from '../text/schema';
import { TrackBBlockedError, TrackBPendingError } from '../service-adapter';

/** Trusted server-held production result, never a request/model-provided approval. */
export interface AuthorizedApprovedSuite {
  job: JobRef;
  context: Pick<DataDesignContext, 'versionLabel' | 'systemPrompt'>;
  result: DataOrchestrationResult;
  /** Current refusal values supplied on every authorized read; never persist these. */
  knownSecrets?: readonly string[];
}
export interface ApprovedSuiteArtifact {
  suite: FrozenTextSuite;
  provenance: DataReferenceProvenance;
}
export interface ApprovedSuiteAdmissionDeps {
  /** Authorize ctx, then load immutable durable production result bound to this digest.
   * Return null only for absence. Pending/rejected/cost-incomplete records must be
   * returned with their original status, never hidden as absence. Implementations
   * must fence conflicting replacements atomically; this port creates no storage.
   */
  resolve(ctx: ServiceContext, suiteDigest: string): Promise<AuthorizedApprovedSuite | null>;
}

/** Public admission boundary for already designed, reviewed and frozen data suites.
 * No design, freeze, target dispatch, checkpoint writes or private checkpoint keys.
 * get retains the complete exact provenance sidecar for private run/report storage.
 */
export function createApprovedSuiteAdmission(deps: ApprovedSuiteAdmissionDeps) {
  const reject = (): never => { throw new TrackBBlockedError('rejected_input', 'Approved suite scope, evidence or provenance mismatch.'); };
  async function get(ctx: ServiceContext, suiteDigest: string): Promise<ApprovedSuiteArtifact | null> {
    if (!/^[a-f0-9]{64}$/.test(suiteDigest)) return reject();
    const resolved = await deps.resolve(ctx, suiteDigest);
    if (resolved === null) return null;
    // Capture the complete trusted snapshot before any additional awaits.
    const { job, context, result, knownSecrets } = structuredClone(resolved);
    if (job.jobId !== ctx.jobId || job.environment !== ctx.environment || job.package !== 'text_eval'
      || result.task.spec.jobId !== job.jobId) return reject();
    if (result.status !== 'ready') throw new TrackBPendingError(5_000, 'Evaluation data approval, cost or reconciliation is incomplete.');
    if (!result.frozen) return reject();
    const suite = verifyAdmittedFrozenSuite(result.frozen.suite);
    if (suite.digest !== suiteDigest || containsSecret(JSON.stringify({ suite, provenance: result.frozen.provenance }), knownSecrets)) return reject();
    const binding = frozenDataReference(result.task, suite, { job, ...context, knownSecrets });
    if (canonicalJson(binding.provenance) !== canonicalJson(result.frozen.provenance)) return reject();
    return structuredClone({ suite, provenance: result.frozen.provenance });
  }
  return {
    get,
    /** Optional rich-service suite lookup hook. A non-ready result throws, never falls back. */
    async resolveApprovedSuite(ctx: ServiceContext, suiteDigest: string): Promise<FrozenTextSuite | null> {
      return (await get(ctx, suiteDigest))?.suite ?? null;
    },
  };
}
