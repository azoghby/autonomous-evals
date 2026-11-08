import { createHash } from 'node:crypto';
import type { TextCheckpointStore, CheckpointKey } from '../integration/checkpoints';
import { canonicalJson, verifyAdmittedFrozenSuite } from '../text/freeze';
import { assertValidRunId, executionGaps, executionVerdict } from '../text/execute';
import { SuiteRunSchema, type FrozenTextSuite, type SuiteRun } from '../text/schema';
import { verifyPack, type FrozenPack, type PackEntry } from './contract';
import type { TrustedRegistry } from './trusted';

export type PackStatus = 'pass' | 'fail' | 'concern' | 'unknown' | 'not_assessed' | 'infrastructure_error';
export type PackInventoryStatus = PackStatus | 'quarantined';
export interface PackCheckEvidence { id: string; status: PackStatus; detail: string; evidenceQuotes: string[] }
export interface PackCaseResult { id: string; specDigest: string | null; status: PackInventoryStatus; checks: PackCheckEvidence[]; reason?: string }
export interface PackDispatchContext {
  jobId: string; runId: string; manifestDigest: string; targetConfigDigest: string;
  authorizationId: string; sourceRuleIds: readonly string[];
  provenance: FrozenPack['provenance'];
}
/** Implemented by the secured target/objective/judge adapter. No executable specs are accepted. */
export interface SecuredPackRunner {
  capabilityVersion: 'secured_pack_runner.v1';
  supports?(entry: PackEntry, context: PackDispatchContext): boolean;
  execute(entry: PackEntry, context: PackDispatchContext): Promise<PackCaseResult>;
}
export interface AuthorizedPackContext {
  jobId: string; environment: string; authorizationId: string; sourceRuleIds: readonly string[];
  /** Resolver derives this from the actual endpoint/model/configuration, never request labels. */
  targetConfigDigest: string;
}
export interface PackRunRequest { runId: string; manifest: FrozenPack; baseSuite: FrozenTextSuite; baseRun: SuiteRun | null }
export interface PackRunEvidence {
  schemaVersion: 'appended_pack_run.v1'; runId: string; manifest: FrozenPack; context: AuthorizedPackContext;
  base: { digest: string; status: PackStatus; expectedIds: string[]; run: SuiteRun | null };
  pack: { status: PackInventoryStatus; expectedIds: string[]; results: PackCaseResult[] };
}
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const statuses: PackStatus[] = ['pass', 'fail', 'concern', 'unknown', 'not_assessed', 'infrastructure_error'];
/** Failures remain visible while gaps retain their own counters/results. */
export function aggregatePackStatuses(values: readonly PackInventoryStatus[]): PackInventoryStatus {
  for (const state of ['fail', 'infrastructure_error', 'unknown', 'not_assessed', 'quarantined', 'concern'] as const) if (values.includes(state)) return state;
  return values.length ? 'pass' : 'unknown';
}
export function expectedPackCheckIds(entry: PackEntry): string[] {
  return entry.spec ? entry.spec.rules.map((_, i) => `${entry.id}.rule.${i + 1}`) : [];
}
function safeResult(entry: PackEntry, result: PackCaseResult): PackCaseResult {
  if (result?.id === entry.id && result.specDigest === entry.specDigest && result.status === 'quarantined' && result.checks?.length === 0 && result.reason === 'runner_unsupported_semantics') return clone(result);
  const ids = expectedPackCheckIds(entry);
  if (!result || result.id !== entry.id || result.specDigest !== entry.specDigest || !Array.isArray(result.checks)
      || !ids.length || result.checks.length !== ids.length || result.checks.some((c, i) => c.id !== ids[i]
        || !statuses.includes(c.status) || typeof c.detail !== 'string' || c.detail.length > 2000
        || !Array.isArray(c.evidenceQuotes) || c.evidenceQuotes.length > 6 || c.evidenceQuotes.some(q => typeof q !== 'string' || q.length > 500))) {
    return { id: entry.id, specDigest: entry.specDigest, status: 'infrastructure_error', checks: [], reason: 'invalid_runner_evidence' };
  }
  // Ignore a runner's aggregate assertion; derive it from every expected rule.
  return { id: entry.id, specDigest: entry.specDigest, status: aggregatePackStatuses(result.checks.map(c => c.status)), checks: clone(result.checks) };
}
function baseEvidence(suite: FrozenTextSuite, raw: SuiteRun | null): PackRunEvidence['base'] {
  const expectedIds = suite.scenarios.map(s => s.id);
  if (!raw) return { digest: suite.digest, expectedIds, status: 'unknown', run: null };
  const run = SuiteRunSchema.parse(raw);
  if (run.jobId !== suite.jobId || run.suiteDigest !== suite.digest || run.executions.length !== expectedIds.length
      || run.executions.some((e, i) => e.scenarioId !== expectedIds[i] || e.runId !== run.runId)) throw new Error('pack_base_run_scope_mismatch');
  const values = run.executions.map((e, i): PackStatus => {
    const expectedChecks = [...suite.scenarios[i]!.objectiveChecks, ...suite.scenarios[i]!.rubricChecks].map(c => c.id);
    if (!expectedChecks.length || e.checks.length !== expectedChecks.length || e.checks.some((c, j) => c.checkId !== expectedChecks[j])) throw new Error('pack_base_check_scope_mismatch');
    if (e.outcome === 'infrastructure_error') return 'infrastructure_error';
    if (e.checks.some(c => c.status === 'fail')) return 'fail';
    if (e.checks.some(c => c.status === 'error')) return 'infrastructure_error';
    if (e.checks.some(c => c.status === 'not_assessed')) return 'not_assessed';
    if (executionGaps(e).length) return 'unknown';
    return executionVerdict(e) === 'concern' ? 'concern' : 'pass';
  });
  return { digest: suite.digest, expectedIds, status: aggregatePackStatuses(values) as PackStatus, run };
}

/** Caller resolver authorizes the job before this service reads or dispatches anything. */
export function createPackExecutionService(deps: {
  checkpoints: TextCheckpointStore; registry: TrustedRegistry; runner: SecuredPackRunner;
  resolve(jobId: string): Promise<AuthorizedPackContext>;
  /** Authenticate reviewer receipt and source-rule authorization against authoritative records. */
  verifyReview(manifest: FrozenPack, context: AuthorizedPackContext): Promise<void>;
}) {
  const store = deps.checkpoints;
  async function prepare(request: PackRunRequest) {
    assertValidRunId(request.runId);
    const suite = verifyAdmittedFrozenSuite(request.baseSuite);
    const manifest = verifyPack(request.manifest, deps.registry);
    const context = clone(await deps.resolve(suite.jobId));
    if (context.jobId !== suite.jobId || !context.environment || context.authorizationId !== manifest.authorization.authorizationId
        || context.targetConfigDigest !== manifest.authorization.targetConfigDigest
        || canonicalJson([...context.sourceRuleIds].sort()) !== canonicalJson([...manifest.authorization.sourceRuleIds].sort())
        || manifest.baseDigest !== suite.digest) throw new Error('pack_authorized_context_mismatch');
    const base = baseEvidence(suite, request.baseRun);
    await deps.verifyReview(manifest, context);
    const artifact = { schemaVersion: 'appended_pack_run.v1' as const, runId: request.runId, manifest, context, base };
    const inputDigest = hash(artifact);
    const key = (kind: string, id = request.runId): CheckpointKey => ({ jobId: context.jobId, kind: `appended_pack:${kind}`, id, inputDigest });
    const k = key('manifest');
    const claim = await store.claim(k);
    if (claim.state === 'claimed') await store.complete(k, claim.token, artifact);
    else if (claim.state !== 'completed') throw new Error(`pack_manifest_${claim.state}`);
    else if (canonicalJson(claim.value) !== canonicalJson(artifact)) throw new Error('pack_manifest_identity_conflict');
    return { artifact, key };
  }
  return {
    async run(request: PackRunRequest): Promise<PackRunEvidence> {
      const { artifact, key } = await prepare(request);
      const dispatch: PackDispatchContext = { jobId: artifact.context.jobId, runId: request.runId, manifestDigest: artifact.manifest.digest,
        targetConfigDigest: artifact.context.targetConfigDigest, authorizationId: artifact.context.authorizationId, sourceRuleIds: artifact.context.sourceRuleIds, provenance: artifact.manifest.provenance };
      const results: PackCaseResult[] = [];
      for (const entry of artifact.manifest.inventory) {
        if (entry.state === 'quarantined') { results.push({ id: entry.id, specDigest: entry.specDigest, status: 'quarantined', checks: [], reason: entry.reason ?? 'unsupported_semantics' }); continue; }
        const k = key('dispatch', hash([request.runId, entry.id]));
        const claim = await store.claim(k);
        if (claim.state === 'completed') { results.push(safeResult(entry, claim.value as PackCaseResult)); continue; }
        if (claim.state !== 'claimed') {
          results.push({ id: entry.id, specDigest: entry.specDigest, status: 'unknown', checks: [], reason: `dispatch_${claim.state}_requires_reconciliation` });
          continue;
        }
        try {
          const result = deps.runner.capabilityVersion !== 'secured_pack_runner.v1' || !deps.runner.supports?.(entry, dispatch)
            ? { id: entry.id, specDigest: entry.specDigest, status: 'quarantined' as const, checks: [], reason: 'runner_unsupported_semantics' }
            : safeResult(entry, await deps.runner.execute(entry, dispatch));
          await store.complete(k, claim.token, result);
          results.push(result);
        } catch {
          // Lost response/worker state is fenced permanently. Never release a dispatch intent.
          await store.markAmbiguous(k, claim.token).catch(() => undefined);
          results.push({ id: entry.id, specDigest: entry.specDigest, status: 'unknown', checks: [], reason: 'dispatch_ambiguous_requires_reconciliation' });
        }
      }
      return { ...artifact, pack: { expectedIds: artifact.manifest.inventory.map(e => e.id), results, status: aggregatePackStatuses(results.map(r => r.status)) } };
    },
    async report(jobId: string, runId: string): Promise<PackRunEvidence> {
      const context = await deps.resolve(jobId);
      if (context.jobId !== jobId) throw new Error('pack_authorized_context_mismatch');
      const stored = await store.get({ jobId, kind: 'appended_pack:manifest', id: runId });
      if (!stored || stored.state !== 'completed') throw new Error('pack_manifest_unavailable');
      const artifact = clone(stored.value) as Omit<PackRunEvidence, 'pack'>;
      if (canonicalJson(context) !== canonicalJson(artifact.context)) throw new Error('pack_authorized_context_mismatch');
      const manifest = verifyPack(artifact.manifest, deps.registry);
      await deps.verifyReview(manifest, context);
      const results: PackCaseResult[] = [];
      for (const entry of manifest.inventory) {
        if (entry.state === 'quarantined') { results.push({ id: entry.id, specDigest: entry.specDigest, status: 'quarantined', checks: [], reason: entry.reason ?? 'unsupported_semantics' }); continue; }
        const value = await store.get({ jobId, kind: 'appended_pack:dispatch', id: hash([runId, entry.id]), inputDigest: hash(artifact) });
        results.push(value?.state === 'completed' ? safeResult(entry, value.value as PackCaseResult) : { id: entry.id, specDigest: entry.specDigest, status: 'unknown', checks: [], reason: value ? `dispatch_${value.state}_requires_reconciliation` : 'not_dispatched' });
      }
      return { ...artifact, manifest, pack: { expectedIds: manifest.inventory.map(e => e.id), results, status: aggregatePackStatuses(results.map(r => r.status)) } };
    },
  };
}

/** Full-scope comparison: every expected ID survives; only matching criteria with assessed outcomes form pairs. */
export function comparePackRuns(left: PackRunEvidence, right: PackRunEvidence, registry: TrustedRegistry) {
  verifyPack(left.manifest, registry); verifyPack(right.manifest, registry);
  const ids = [...new Set([...left.manifest.inventory.map(e => e.id), ...right.manifest.inventory.map(e => e.id)])];
  return ids.map(id => {
    const a = left.manifest.inventory.find(e => e.id === id), b = right.manifest.inventory.find(e => e.id === id);
    const leftRaw = left.pack.results.find(e => e.id === id), rightRaw = right.pack.results.find(e => e.id === id);
    const ar = a?.state === 'accepted' && leftRaw ? safeResult(a, leftRaw) : undefined;
    const br = b?.state === 'accepted' && rightRaw ? safeResult(b, rightRaw) : undefined;
    const assessed = (r?: PackCaseResult) => r && ['pass', 'fail', 'concern'].includes(r.status);
    const reason = !a || !b ? 'missing_expected_case' : left.manifest.baseDigest !== right.manifest.baseDigest
      || canonicalJson(left.manifest.provenance) !== canonicalJson(right.manifest.provenance)
      || canonicalJson([...left.manifest.authorization.sourceRuleIds].sort()) !== canonicalJson([...right.manifest.authorization.sourceRuleIds].sort())
      || a.specDigest !== b.specDigest ? 'changed_criteria' : !assessed(ar) || !assessed(br) ? 'unassessed_pair' : null;
    return { id, paired: reason === null, reason, left: a?.state === 'quarantined' ? 'quarantined' : ar?.status ?? 'unknown', right: b?.state === 'quarantined' ? 'quarantined' : br?.status ?? 'unknown' };
  });
}
