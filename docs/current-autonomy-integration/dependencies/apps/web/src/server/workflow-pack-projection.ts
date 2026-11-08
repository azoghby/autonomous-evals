import 'server-only';
import { containsSecret } from '@ae/core/agents/redact';
import { canonicalPackJson, packDigest, aggregatePackStatuses, expectedPackCheckIds,
  type PackRunEvidence, type PackInventoryStatus } from '@ae/core/evals/packs/index';
import { SuiteRunSchema } from '@ae/core/evals/text/schema';

const same = (a: unknown, b: unknown) => canonicalPackJson(a) === canonicalPackJson(b);
const states: PackInventoryStatus[] = ['pass', 'fail', 'concern', 'unknown', 'not_assessed', 'infrastructure_error', 'quarantined'];
const refused = (): never => { throw new Error('workflow_pack_evidence_invalid'); };
/** Input must come from the authorized core service.report(), never intake.
 * Integrity checks here do not issue review authority or reinterpret historical specs. */
export function projectWorkflowPack(evidence: PackRunEvidence) {
  const e = evidence;
  if (!e || e.schemaVersion !== 'appended_pack_run.v1' || !e.runId || !e.context?.jobId
    || !e.manifest || !e.base || !e.pack) return refused();
  const { digest, ...body } = e.manifest;
  if (packDigest(body) !== digest || e.manifest.baseDigest !== e.base.digest
    || e.context.authorizationId !== e.manifest.authorization.authorizationId
    || e.context.targetConfigDigest !== e.manifest.authorization.targetConfigDigest
    || !same([...e.context.sourceRuleIds].sort(), [...e.manifest.authorization.sourceRuleIds].sort())) return refused();
  const ids = e.manifest.inventory.map(entry => entry.id);
  if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length
    || ids.some(id => !/^rt_[a-z0-9_]+$/.test(id)) || !same(ids, e.pack.expectedIds)
    || e.base.expectedIds.length !== 12 || new Set(e.base.expectedIds).size !== 12
    || e.base.expectedIds.some(id => id.startsWith('rt_'))) return refused();
  if (new Set(e.pack.results.map(r => r.id)).size !== e.pack.results.length
    || e.pack.results.some(r => !ids.includes(r.id))) return refused();
  const cases = e.manifest.inventory.map(entry => {
    const result = e.pack.results.find(r => r.id === entry.id);
    const expected = expectedPackCheckIds(entry);
    let status: PackInventoryStatus = 'unknown';
    let reason = 'missing_or_invalid_evidence';
    if (entry.state === 'quarantined') { status = 'quarantined'; reason = entry.reason ?? 'unsupported_pack_semantics'; }
    else if (result?.specDigest === entry.specDigest) {
      if (result.status === 'quarantined' && result.reason === 'runner_unsupported_semantics' && result.checks.length === 0) {
        status = 'quarantined'; reason = result.reason;
      } else if (expected.length > 0 && same(expected, result.checks.map(c => c.id))
        && result.checks.every(c => states.includes(c.status) && c.status !== ('quarantined' as string))) {
        status = aggregatePackStatuses(result.checks.map(c => c.status)); reason = '';
      } else if (result.status === 'unknown' || result.status === 'infrastructure_error') {
        status = result.status; reason = result.reason ?? 'incomplete_evidence';
      }
    }
    return { id: entry.id, admission: entry.state, specDigest: entry.specDigest, status, reason,
      expectedCheckIds: expected };
  });
  let baseStatus: PackInventoryStatus = 'unknown';
  if (e.base.run) {
    const parsed = SuiteRunSchema.safeParse(e.base.run);
    if (!parsed.success) return refused();
    const run = parsed.data;
    if (run.jobId !== e.context.jobId || run.suiteDigest !== e.base.digest
      || !same(e.base.expectedIds, run.executions.map(x => x.scenarioId))
      || run.executions.some(x => x.runId !== run.runId)) return refused();
    // The core report validates exact frozen check inventory. Keep gaps explicit here too.
    baseStatus = aggregatePackStatuses(run.executions.map(x => {
      if (x.checks.some(c => c.status === 'fail')) return 'fail';
      if (x.outcome === 'infrastructure_error' || x.checks.some(c => c.status === 'error')) return 'infrastructure_error';
      if (!x.checks.length || x.checks.some(c => c.status === 'inconclusive')) return 'unknown';
      if (x.checks.some(c => c.status === 'not_assessed')) return 'not_assessed';
      return x.checks.some(c => c.status === 'concern') ? 'concern' : 'pass';
    }));
    // Never upgrade the authoritative base summary to pass through a projection.
    if (baseStatus === 'pass' && e.base.status !== 'pass') baseStatus = states.includes(e.base.status) ? e.base.status : 'unknown';
  }
  const packStatus = aggregatePackStatuses(cases.map(c => c.status));
  const fullStatus = aggregatePackStatuses([baseStatus, packStatus]);
  return { schemaVersion: 'workflow_pack_projection.v1' as const, runId: e.runId, manifestDigest: digest,
    baseline: { runId: e.base.run?.runId ?? null, digest: e.base.digest },
    base12: { status: baseStatus, expectedIds: [...e.base.expectedIds] },
    appendedPack: { status: packStatus, expectedIds: ids, cases },
    fullScope: { status: fullStatus, passed: fullStatus === 'pass' },
    remediation: { scope: 'base12_only' as const, certifiesPack: false as const },
    comparison: { requiresRetainedFullArtifactDigest: true as const, requiresCoreComparePackRuns: true as const } };
}

/** Preserve the full raw scopes privately; public projections contain no responses/specs. */
export function attachWorkflowPackEvidence<T extends { suite: { digest?: string; hash?: string } }>(base: T, pack: PackRunEvidence) {
  projectWorkflowPack(pack);
  if ((base.suite.digest ?? base.suite.hash) !== pack.base.digest) return refused();
  return JSON.parse(canonicalPackJson({ ...base, appendedPack: pack })) as T & { appendedPack: PackRunEvidence };
}
export function workflowPackFromArtifact(body: unknown): PackRunEvidence | null {
  if (!body || typeof body !== 'object' || !('appendedPack' in body)) return null;
  const pack = (body as { appendedPack: PackRunEvidence }).appendedPack;
  projectWorkflowPack(pack);
  return pack;
}
/** Fixed vocabulary and validated IDs only: no target output, rules, reasons or credentials. */
export function appendWorkflowPackReport(markdown: string, evidence: PackRunEvidence): string {
  const p = projectWorkflowPack(evidence);
  return markdown + '\n\n## Appended evaluation scope\n\n'
    + `Base12: ${p.base12.status}. Appended pack: ${p.appendedPack.status}. Full scope: ${p.fullScope.status}.\n\n`
    + p.appendedPack.cases.map(c => `- ${c.id}: ${c.status} (${c.admission})`).join('\n')
    + '\n\nUnknown, unassessed and quarantined cases are not passes. Base12 remediation cannot certify appended cases. '
    + 'Comparison requires retained full-artifact baseline identity and separate core pack comparison.\n';
}

/** Bind monitoring ticks/comparison baselines to the COMPLETE retained artifact.
 * Never substitute the frozen base-suite digest or base12 remediation run identity. */
export function retainedWorkflowPackBaseline(body: unknown) {
  const evidence = workflowPackFromArtifact(body);
  if (!evidence) return refused();
  return { runId: evidence.runId, digest: packDigest(body) };
}

/** The core manifest's authorization is structured identity metadata, not an HTTP
 * credential assignment. Rename only that exact object KEY for the scan; scan all
 * its values and all remaining evidence normally. Stored bytes/digests stay intact. */
export function containsWorkflowPackArtifactSecret(body: unknown, knownSecrets: readonly string[]) {
  const pack = workflowPackFromArtifact(body);
  if (!pack) return containsSecret(canonicalPackJson(body), knownSecrets);
  const scan = JSON.parse(canonicalPackJson(body));
  const binding = scan.appendedPack.manifest.authorization;
  delete scan.appendedPack.manifest.authorization;
  scan.appendedPack.manifest.reviewAuthorizationBinding = binding;
  return containsSecret(canonicalPackJson(scan), knownSecrets);
}
