import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ServiceContext } from '../contracts/services';
import { containsSecret } from '../agents/redact';
import { TrackBBlockedError, TrackBPendingError } from '../evals/service-adapter';
import type { TextCheckpointStore, CheckpointKey } from '../evals/integration/checkpoints';
import { canonicalJson, verifyAdmittedFrozenSuite, SuiteRunSchema, assertRunMatches } from '../evals/text';
import type { FrozenTextSuite, SuiteRun } from '../evals/text';
import { freezeCalendarSuite, compareFrozenCalendarRuns } from '../simulator/workflow';
import type { FrozenCalendarSuite, CalendarWorkflowRun } from '../simulator/workflow';

export type ComparisonSuite = FrozenTextSuite | FrozenCalendarSuite;
export type RichOutcome = 'passed' | 'failed' | 'rubric_concern' | 'not_assessed' | 'inconclusive' | 'infrastructure_error' | 'check_error';
export interface RichCheck { scenarioId: string; checkId: string; outcome: RichOutcome; evidenceIds: string[] }
export interface MeasuredCost { id: string; source: string; microUsd: number; measured: true }
interface ArtifactBase { investigation: unknown; limitations: string[]; costs: MeasuredCost[]; unknownCosts: string[] }
export type RichRunArtifact = ArtifactBase & ({ kind: 'text'; suite: FrozenTextSuite; run: SuiteRun } | { kind: 'calendar'; suite: FrozenCalendarSuite; run: CalendarWorkflowRun });
export interface RichEvaluationAdapter {
  /** Monitoring baselines must read retained evidence without external dispatch. */
  readonly readOnly?: boolean;
  /** Canonical retained evidence identity, required for read-only replay. */
  readonly retainedIdentity?: { runId: string; digest: string };
  /** Read the already reviewed frozen artifact, without generating tests or sending target calls. */
  getSuite(): Promise<ComparisonSuite>;
  execute(input: { operationId: string; version: string }): Promise<RichRunArtifact>;
}
export interface VersionBinding { version: string; targetId: string; branchId: string | null; adapter: RichEvaluationAdapter }
export interface ComparisonRequest { operationId: string; baselineVersion: string; currentVersion: string; mode: 'comparison' | 'monitoring' }
export interface AuthorizedComparison {
  tenantId: string; jobId: string; environment: 'live' | 'test'; isFixture: boolean;
  suite: ComparisonSuite;
  /** Complete application inventory, INCLUDING appended red-team cases. Unsupported packs fail closed. */
  scenarioIds: string[];
  baseline: VersionBinding; current: VersionBinding; knownSecrets?: readonly string[];
}
export interface ComparisonMonitoringDeps {
  checkpoints: TextCheckpointStore;
  /** Must authenticate principal, tenant/job/environment, target config, branch ownership, billing/budget and suite inventory on EVERY call. */
  resolve(ctx: ServiceContext, request: ComparisonRequest): Promise<AuthorizedComparison>;
}
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const requestSchema = z.object({ operationId: id, baselineVersion: id, currentVersion: id, mode: z.enum(['comparison', 'monitoring']) }).strict();
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const reject = (): never => { throw new TrackBBlockedError('rejected_input', 'Comparison authorization, frozen inventory or evidence identity mismatch.'); };
const ambiguous = (): never => { throw new TrackBBlockedError('needs_operator', 'Comparison execution is unresolved; reconcile the retained operation before redispatch.'); };
function suite(input: ComparisonSuite): ComparisonSuite {
  if ('digest' in input) return verifyAdmittedFrozenSuite(input);
  const { hash: expected, ...body } = input;
  const verified = freezeCalendarSuite(body);
  if (verified.hash !== expected) reject();
  return verified;
}
function same(a: unknown, b: unknown) { if (canonicalJson(a) !== canonicalJson(b)) reject(); }
function inventory(actual: string[], expected: string[]) {
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length) reject();
  same([...actual].sort(), [...expected].sort());
}
function assertJson(value: unknown, secrets?: readonly string[]) {
  const serialized = JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'number' && !Number.isFinite(v) || typeof v === 'bigint' || typeof v === 'function' || typeof v === 'symbol') reject();
    if (typeof v === 'string' && /[\u0000\uD800-\uDFFF]/u.test(v)) reject();
    return v;
  });
  if (!serialized || containsSecret(serialized, secrets)) reject();
}
export function richChecks(artifact: RichRunArtifact): RichCheck[] {
  const frozen = suite(artifact.suite);
  if (artifact.kind === 'text') {
    if (!('digest' in frozen)) return reject();
    const run = SuiteRunSchema.parse(artifact.run);
    assertRunMatches(frozen, run);
    inventory(run.executions.map(e => e.scenarioId), frozen.scenarios.map(s => s.id));
    if (run.executions.some(e => (e.outcome === 'completed') !== e.target.ok)) reject();
    return run.executions.flatMap(e => e.checks.map(c => ({ scenarioId: e.scenarioId, checkId: c.checkId,
      outcome: e.outcome === 'infrastructure_error' ? 'infrastructure_error' : c.status === 'error' ? 'check_error' : c.status === 'not_assessed' ? 'not_assessed' : c.status === 'concern' ? 'rubric_concern' : c.status === 'pass' ? 'passed' : c.status === 'fail' ? c.kind === 'objective' ? 'failed' : 'rubric_concern' : 'inconclusive',
      evidenceIds: [`text:${run.runId}:${e.scenarioId}:${c.checkId}`],
    })));
  }
  if (!('hash' in frozen)) return reject();
  const r = artifact.run;
  if (r.jobId !== frozen.jobId || r.suiteHash !== frozen.hash || r.origin !== frozen.origin || !id.safeParse(r.runId).success) reject();
  inventory(r.results.map(e => e.scenarioId), frozen.scenarios.map(s => s.id));
  const scopeIds = new Set<string>();
  return r.results.map(e => {
    if (!['passed', 'product_failure', 'inconclusive', 'infrastructure_error'].includes(e.outcome)
      || e.scope.jobId !== r.jobId || e.scope.version !== r.versionLabel || !id.safeParse(e.scope.runId).success || scopeIds.has(e.scope.runId)) reject();
    scopeIds.add(e.scope.runId);
    if (e.execution) { same(e.execution.scope, e.scope); if (e.execution.scenarioId !== e.scenarioId) reject(); }
    const scenario = frozen.scenarios.find(s => s.id === e.scenarioId)!;
    const validateGrade = (grade: typeof e.stateGrade, expected: typeof scenario.checks) => {
      if (!grade || typeof grade.passed !== 'boolean' || !Array.isArray(grade.results)
        || grade.results.some(g => typeof g.passed !== 'boolean')) return reject();
      same(grade.results.map(g => g.check), expected);
      if (grade.passed !== grade.results.every(g => g.passed)) reject();
    };
    if (e.stateGrade) validateGrade(e.stateGrade, scenario.checks);
    if (e.claimGrade) {
      if (!scenario.claimRequiredState) reject();
      validateGrade(e.claimGrade, scenario.claimRequiredState!);
    }
    let outcome: string; let reason: string;
    if (!e.execution) {
      if (e.stateGrade || e.claimGrade || e.claim) reject();
      outcome = 'infrastructure_error'; reason = 'execution_unavailable';
    }
    else if (e.execution.stopped !== 'complete') {
      if (!['round_limit', 'invalid_response', 'target_error', 'simulator_error'].includes(e.execution.stopped)) reject();
      outcome = ['round_limit', 'invalid_response'].includes(e.execution.stopped) ? 'inconclusive' : 'infrastructure_error';
      reason = e.execution.stopped;
      if (e.stateGrade || e.claimGrade) reject();
    } else if (!e.stateGrade) { outcome = 'infrastructure_error'; reason = 'sql_grading_unavailable'; }
    else {
      if (scenario.claimRequiredState && !e.claimGrade) reject();
      const claim = e.claim ?? 'unknown';
      if (!['success', 'no_success', 'unknown'].includes(claim)) reject();
      if (claim !== 'unknown' && (!scenario.claimRequiredState || !e.execution.messages.filter(m => m.role === 'assistant').at(-1)?.content?.trim())) reject();
      if (!e.stateGrade.passed) { outcome = 'product_failure'; reason = 'state_mismatch'; }
      else if (scenario.claimRequiredState && claim === 'unknown') { outcome = 'inconclusive'; reason = 'claim_not_assessed'; }
      else if (claim === 'success' && e.claimGrade && !e.claimGrade.passed) { outcome = 'product_failure'; reason = 'false_success'; }
      else { outcome = 'passed'; reason = 'sql_checks_passed'; }
    }
    if (e.outcome !== outcome || e.reason !== reason) reject();
    return { scenarioId: e.scenarioId, checkId: 'calendar_workflow', outcome: e.outcome === 'product_failure' ? 'failed' : e.outcome,
      evidenceIds: [`calendar:${r.runId}:${e.scope.runId}`] };
  });
}
const outcomes: RichOutcome[] = ['passed', 'failed', 'rubric_concern', 'not_assessed', 'inconclusive', 'infrastructure_error', 'check_error'];
export function compareRichChecks(before: RichCheck[], after: RichCheck[]) {
  const key = (c: RichCheck) => canonicalJson([c.scenarioId, c.checkId]);
  if (!before.length) reject();
  inventory(before.map(key), after.map(key));
  for (const c of [...before, ...after]) if (!outcomes.includes(c.outcome) || !c.evidenceIds.length) reject();
  const current = new Map(after.map(c => [key(c), c]));
  const changes = before.map(baseline => ({ baseline, current: current.get(key(baseline))! }));
  const assessed = (c: RichCheck) => c.outcome === 'passed' || c.outcome === 'failed';
  const paired = changes.filter(p => assessed(p.baseline) && assessed(p.current));
  const counts = (checks: RichCheck[]) => Object.fromEntries(outcomes.map(o => [o, checks.filter(c => c.outcome === o).length])) as Record<RichOutcome, number>;
  return { totalChecks: before.length, pairedAssessed: paired.length, baselineCounts: counts(before), currentCounts: counts(after),
    passRateDelta: paired.length ? (paired.filter(p => p.current.outcome === 'passed').length - paired.filter(p => p.baseline.outcome === 'passed').length) / paired.length : null,
    regressions: changes.filter(p => p.baseline.outcome === 'passed' && p.current.outcome === 'failed'),
    improvements: changes.filter(p => p.baseline.outcome === 'failed' && p.current.outcome === 'passed'),
    changes: changes.filter(p => p.baseline.outcome !== p.current.outcome), unresolved: changes.filter(p => !assessed(p.baseline) || !assessed(p.current)),
    interpretation: 'observed_changes_only' as const };
}

/** Composition never releases claims. A crash after committed intent requires explicit reconciliation. */
export function createComparisonMonitoringService(deps: ComparisonMonitoringDeps) {
  return {
    async compare(ctx: ServiceContext, input: ComparisonRequest) {
      let request: ComparisonRequest; let a: AuthorizedComparison;
      try { request = requestSchema.parse(input); a = await deps.resolve(ctx, copy(request)); } catch { return reject(); }
      const safe = <T>(v: T): T => { assertJson(v, a.knownSecrets); return copy(v); };
      const durable = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch { return ambiguous(); } };
      const frozen = suite(a.suite);
      if (a.jobId !== ctx.jobId || a.environment !== ctx.environment || !id.safeParse(a.tenantId).success || typeof a.isFixture !== 'boolean'
        || frozen.jobId !== a.jobId || a.baseline.version !== request.baselineVersion || a.current.version !== request.currentVersion
        || request.mode === 'comparison' && request.baselineVersion === request.currentVersion
        || 'origin' in frozen && frozen.origin === 'internal_fixture' && !a.isFixture) reject();
      if (request.mode === 'monitoring' && a.baseline.adapter.readOnly !== true) reject();
      inventory(a.scenarioIds, frozen.scenarios.map(s => s.id));
      for (const b of [a.baseline, a.current]) {
        if (!id.safeParse(b.version).success || !id.safeParse(b.targetId).success || b.branchId !== null && !id.safeParse(b.branchId).success || 'hash' in frozen && b.branchId === null) reject();
        let bound: ComparisonSuite;
        try { bound = suite(await b.adapter.getSuite()); } catch { return reject(); }
        same(frozen, bound);
      }
      for (const b of [a.baseline, a.current]) if (b.adapter.readOnly === true && !z.object({ runId: id, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(b.adapter.retainedIdentity).success) reject();
      const identity = (b: VersionBinding) => ({ retainedIdentity: b.adapter.readOnly === true ? b.adapter.retainedIdentity : null, tenantId: a.tenantId, jobId: a.jobId, environment: a.environment, version: b.version, targetId: b.targetId, branchId: b.branchId });
      const binding = safe({ request, suite: frozen, scenarioIds: a.scenarioIds, isFixture: a.isFixture, baseline: identity(a.baseline), current: identity(a.current) });
      const base: CheckpointKey = { jobId: a.jobId, kind: 'rich_comparison_identity', id: request.operationId, inputDigest: hash(binding) };
      const phase = async <T>(k: CheckpointKey, action: () => Promise<T>): Promise<T> => {
        const c = await durable(() => deps.checkpoints.claim(k));
        if (c.state === 'completed') return safe(c.value) as T;
        if (c.state === 'pending') throw new TrackBPendingError(5_000, 'Comparison pending; reconcile a lost worker before retry.');
        if (c.state !== 'claimed') return ambiguous();
        try {
          const result = safe(await action());
          await durable(() => deps.checkpoints.complete(k, c.token, result));
          return result;
        } catch {
          try { await deps.checkpoints.markAmbiguous(k, c.token); } catch { /* Preserve committed result if acknowledgement was lost. */ }
          return ambiguous();
        }
      };
      await phase(base, async () => binding);
      const execute = (b: VersionBinding, side: string) => phase({ ...base, kind: `rich_comparison_${side}` }, async () => {
        const operationId = hash([a.tenantId, a.jobId, request.operationId, side]);
        const artifact = safe(await b.adapter.execute({ operationId, version: b.version }));
        same(artifact.suite, frozen);
        if (b.adapter.readOnly === true) same({ runId: artifact.run.runId, digest: hash(artifact) }, b.adapter.retainedIdentity);
        if (artifact.kind === 'calendar' && (artifact.run.branchId !== b.branchId || artifact.run.versionLabel !== b.version)) reject();
        if (artifact.kind === 'text' && b.adapter.readOnly !== true && artifact.run.runId !== operationId) reject();
        const checks = richChecks(artifact);
        if (!z.array(z.string()).safeParse(artifact.limitations).success || !Array.isArray(artifact.costs) || !z.array(z.string()).safeParse(artifact.unknownCosts).success || artifact.investigation === undefined) reject();
        return { identity: identity(b), artifact, checks };
      });
      const baseline = await execute(a.baseline, 'baseline');
      const current = await execute(a.current, 'current');
      if (baseline.artifact.run.runId === current.artifact.run.runId) reject();
      if (baseline.artifact.kind === 'calendar' && current.artifact.kind === 'calendar') {
        const scopes = new Set(baseline.artifact.run.results.map(r => r.scope.runId));
        if (current.artifact.run.results.some(r => scopes.has(r.scope.runId))) reject();
      }
      const comparison = compareRichChecks(baseline.checks, current.checks);
      const entries = new Map<string, MeasuredCost>();
      for (const c of [...baseline.artifact.costs, ...current.artifact.costs]) {
        if (!id.safeParse(c.id).success || !id.safeParse(c.source).success || c.measured !== true || !Number.isSafeInteger(c.microUsd) || c.microUsd < 0) reject();
        const key = canonicalJson([c.source, c.id]); const prior = entries.get(key);
        if (prior) same(prior, c); else entries.set(key, c);
      }
      const knownMicroUsd = [...entries.values()].reduce((sum, c) => sum + c.microUsd, 0);
      if (!Number.isSafeInteger(knownMicroUsd)) reject();
      const costs = { knownMicroUsd, entries: [...entries.values()], unknown: [...new Set(['Hosting and customer provider costs are not measured by this composition.', ...baseline.artifact.unknownCosts, ...current.artifact.unknownCosts])] };
      const alertDraft = request.mode === 'monitoring' && (comparison.changes.length || comparison.unresolved.length) ? {
        subject: `Evaluation monitoring: ${comparison.regressions.length} observed regressions; ${comparison.unresolved.length} unresolved comparisons`,
        text: `${comparison.changes.length} check outcomes changed on the identical frozen suite. Review the authenticated evidence. Infrastructure errors and unassessed checks are unresolved, not product regressions. Observed changes only; statistical significance is not assessed.`,
      } : null;
      const calendarDifferences = baseline.artifact.kind === 'calendar' && current.artifact.kind === 'calendar' ? compareFrozenCalendarRuns(baseline.artifact.run, current.artifact.run) : null;
      return safe({ baseline, current, comparison, costs, alertDraft, calendarDifferences, isFixture: a.isFixture,
        limitations: ['Observed changes only; statistical significance is not assessed.', ...baseline.artifact.limitations, ...current.artifact.limitations] });
    },
  };
}
