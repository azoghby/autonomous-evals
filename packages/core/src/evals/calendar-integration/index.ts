import { createHash } from 'node:crypto';
import type { ServiceContext } from '../../contracts/services';
import { containsSecret } from '../../agents/redact';
import { isPersistableText } from '../../targets/chat';
import type { JobRef } from '../types';
import { TrackBBlockedError, TrackBPendingError } from '../service-adapter';
import { canonicalJson } from '../text';
import type { CheckpointKey, CheckpointValue, TextCheckpointStore } from '../integration/checkpoints';
import type { SqlPool } from '../../simulator/pool';
import { PostgresWorkflowInvestigationJournal } from '../../simulator/workflow/postgres-journal';
import { freezeCalendarSuite, investigateCalendarRun, runCalendarSuite } from '../../simulator/workflow';
import type { CalendarSuiteInput, CalendarWorkflowDependencies, CalendarWorkflowRun, FrozenCalendarSuite, WorkflowInvestigationJournal } from '../../simulator/workflow';

export interface AuthorizedCalendarDependencies {
  /** Trusted resolver authorizes caller, job, reviewed artifact, and branch/target association. */
  job: JobRef;
  targetVersion: string;
  branch: { jobId: string; branchId: string; targetVersion: string };
  dependencies: CalendarWorkflowDependencies;
  /** Loaded from trusted reviewed storage; never supplied by the request payload. */
  reviewedSuite: CalendarSuiteInput;
  systemPrompt?: string;
  knownSecrets?: readonly string[];
}
export interface CalendarEvaluationServiceDeps {
  checkpoints: TextCheckpointStore;
  /** Durable application DB, distinct from disposable simulator storage. */
  journalPool: SqlPool;
  resolve(ctx: ServiceContext): Promise<AuthorizedCalendarDependencies>;
}
export interface CalendarSuiteReference { suiteId: string }
export interface CalendarRunRequest extends CalendarSuiteReference { operationId: string; versionLabel: string }
export type CalendarInvestigation = Awaited<ReturnType<typeof investigateCalendarRun>>;

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function rejected(): never { throw new TrackBBlockedError('rejected_input', 'Calendar authorization or artifact identity mismatch.'); }
function blocked(): never { throw new TrackBBlockedError('needs_operator', 'Calendar operation is ambiguous; reconcile retained evidence before any redispatch.'); }
function requestSnapshot<T extends CalendarSuiteReference>(input: T, run = false): T {
  const fields = run ? ['suiteId', 'operationId', 'versionLabel'] : ['suiteId'];
  if (!input || fields.some(field => {
    const value = (input as unknown as Record<string, unknown>)[field];
    return typeof value !== 'string' || value.length < 1 || value.length > 128 || !isPersistableText(value);
  })) rejected();
  return Object.fromEntries(fields.map(field => [field, (input as unknown as Record<string, unknown>)[field]])) as unknown as T;
}
function read<T>(entry: CheckpointValue | null): T {
  if (!entry) return rejected();
  if (entry.state === 'ambiguous') return blocked();
  if (entry.state === 'pending') throw new TrackBPendingError(5_000, 'Calendar phase is pending; a lost worker requires operator reconciliation.');
  return copy(entry.value) as T;
}

/** Additive rich service boundary. Stable operation IDs belong to Workflow, not customer content.
 * No claim is released: crash recovery favors at-most-once dispatch over availability. */
export function createCalendarEvaluationServices(deps: CalendarEvaluationServiceDeps) {
  // Driver/resolver exceptions may carry endpoint credentials. Never return their text.
  async function access<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch { throw new TrackBBlockedError('needs_operator', 'Calendar durable storage access failed; reconcile the stable operation before retrying.'); }
  }
  const store: TextCheckpointStore = {
    claim: k => access(() => deps.checkpoints.claim(k)),
    get: k => access(() => deps.checkpoints.get(k)),
    complete: (k, token, value) => access(() => deps.checkpoints.complete(k, token, value)),
    release: (k, token) => access(() => deps.checkpoints.release(k, token)),
    markAmbiguous: (k, token) => access(() => deps.checkpoints.markAmbiguous(k, token)),
  };
  function safe<T>(a: AuthorizedCalendarDependencies, value: T): T {
    if (containsSecret(JSON.stringify(value), a.knownSecrets)) throw new TrackBBlockedError('needs_operator', 'Calendar artifact contains credential material; evidence was refused.');
    return value;
  }
  async function authorize(ctx: ServiceContext) {
    let a: AuthorizedCalendarDependencies;
    try { a = await deps.resolve(ctx); } catch { return rejected(); }
    if (a.job.jobId !== ctx.jobId || a.job.environment !== ctx.environment || a.job.package !== 'workflow_eval'
      || !/^[A-Za-z0-9_.:-]{1,128}$/.test(a.targetVersion) || !/^[A-Za-z0-9_-]{1,128}$/.test(a.branch.branchId) || a.branch.jobId !== ctx.jobId
      || a.branch.targetVersion !== a.targetVersion || a.reviewedSuite.jobId !== ctx.jobId
      || (a.reviewedSuite.origin === 'internal_fixture' && !a.job.isFixture)) rejected();
    if (a.systemPrompt !== undefined && (typeof a.systemPrompt !== 'string' || a.systemPrompt.length > 20_000 || !isPersistableText(a.systemPrompt))) rejected();
    const suite = freezeCalendarSuite(a.reviewedSuite);
    safe(a, { job: a.job, suite, systemPrompt: a.systemPrompt ?? null, targetVersion: a.targetVersion, branch: a.branch });
    return { a, suite };
  }
  function key(a: AuthorizedCalendarDependencies, suite: FrozenCalendarSuite, kind: string, id: string, extra: unknown = null): CheckpointKey {
    return safe(a, { jobId: a.job.jobId, kind: `calendar_${kind}`, id, inputDigest: digest({
      environment: a.job.environment, customerId: a.job.customerId, suiteHash: suite.hash,
      systemPrompt: a.systemPrompt ?? null, targetVersion: a.targetVersion, branch: a.branch, extra,
    }) });
  }
  async function suiteFor(a: AuthorizedCalendarDependencies, expected: FrozenCalendarSuite, input: CalendarSuiteReference) {
    const stored = safe(a, read<FrozenCalendarSuite>(await store.get(key(a, expected, 'suite', input.suiteId))));
    const { hash, ...body } = stored;
    const suite = freezeCalendarSuite(body);
    if (hash !== suite.hash || hash !== expected.hash) rejected();
    return suite;
  }
  async function operation<T>(a: AuthorizedCalendarDependencies, k: CheckpointKey, action: () => Promise<T>): Promise<T> {
    // Await committed intent before any engine/target dispatch. Failed acknowledgement never retries.
    const claim = await store.claim(k);
    if (claim.state !== 'claimed') return safe(a, read<T>(claim));
    try {
      const result = copy(safe(a, await action()));
      safe(a, { key: k, result });
      await store.complete(k, claim.token, result);
      return safe(a, result);
    } catch {
      try { await store.markAmbiguous(k, claim.token); } catch { /* Completion may already be committed. */ }
      return blocked();
    }
  }
  const runKey = (a: AuthorizedCalendarDependencies, suite: FrozenCalendarSuite, input: CalendarRunRequest) =>
    key(a, suite, 'run', input.operationId, { suiteId: input.suiteId, versionLabel: input.versionLabel });
  async function loadRun(a: AuthorizedCalendarDependencies, suite: FrozenCalendarSuite, input: CalendarRunRequest) {
    const run = safe(a, read<CalendarWorkflowRun>(await store.get(runKey(a, suite, input))));
    if (run.jobId !== a.job.jobId || run.branchId !== a.branch.branchId || run.suiteHash !== suite.hash
      || run.versionLabel !== input.versionLabel || run.systemPrompt !== a.systemPrompt) rejected();
    return run;
  }
  function journal(a: AuthorizedCalendarDependencies): WorkflowInvestigationJournal {
    const inner = new PostgresWorkflowInvestigationJournal(deps.journalPool, a.job.customerId);
    return {
      withLock: (k, action) => inner.withLock(k, action),
      async load(k) { const record = await inner.load(k); return record ? safe(a, record) : undefined; },
      async save(k, record) { safe(a, record); await inner.save(k, record); },
    };
  }
  function investigationKey(a: AuthorizedCalendarDependencies, suite: FrozenCalendarSuite, input: CalendarRunRequest, run: CalendarWorkflowRun) {
    return key(a, suite, 'investigation', input.operationId, { runKey: runKey(a, suite, input), run });
  }
  return {
    async freezeSuite(ctx: ServiceContext, input: CalendarSuiteReference): Promise<FrozenCalendarSuite> {
      input = requestSnapshot(input);
      const { a, suite } = await authorize(ctx);
      return operation(a, key(a, suite, 'suite', input.suiteId), async () => suite);
    },
    async getSuite(ctx: ServiceContext, input: CalendarSuiteReference) {
      input = requestSnapshot(input);
      const { a, suite } = await authorize(ctx);
      return suiteFor(a, suite, input);
    },
    async runSuite(ctx: ServiceContext, input: CalendarRunRequest) {
      input = requestSnapshot(input, true);
      const { a, suite: expected } = await authorize(ctx);
      const suite = await suiteFor(a, expected, input);
      return operation(a, runKey(a, suite, input), () => runCalendarSuite({ suite, versionLabel: input.versionLabel,
        branchId: a.branch.branchId, systemPrompt: a.systemPrompt, dependencies: a.dependencies }));
    },
    async investigate(ctx: ServiceContext, input: CalendarRunRequest): Promise<CalendarInvestigation> {
      input = requestSnapshot(input, true);
      const { a, suite: expected } = await authorize(ctx);
      const suite = await suiteFor(a, expected, input);
      const run = await loadRun(a, suite, input);
      return operation(a, investigationKey(a, suite, input, run), () => investigateCalendarRun({ suite, run, dependencies: a.dependencies, journal: journal(a) }));
    },
    async reportInput(ctx: ServiceContext, input: CalendarRunRequest) {
      input = requestSnapshot(input, true);
      const { a, suite: expected } = await authorize(ctx);
      const suite = await suiteFor(a, expected, input);
      const run = await loadRun(a, suite, input);
      const investigation = safe(a, read<CalendarInvestigation>(await store.get(investigationKey(a, suite, input, run))));
      const unresolved = run.results.filter(r => r.outcome === 'inconclusive' || r.outcome === 'infrastructure_error');
      return safe(a, { suite, run, investigation, findings: investigation.findings,
        status: investigation.pendingScenarioIds.length ? 'needs_operator' as const : unresolved.length || investigation.findings.some(f => f.status === 'inconclusive') ? 'unresolved' as const : 'completed' as const,
        limitations: [
          'Deterministic calendar suite evidence; statistical significance not assessed.',
          ...unresolved.map(r => `${r.scenarioId}: ${r.outcome} (${r.reason}).`),
          ...investigation.pendingScenarioIds.map(id => `${id}: reproduction pending; operator reconciliation required.`),
        ],
        monitoring: { jobId: run.jobId, runId: run.runId, suiteDigest: suite.hash, targetVersion: a.targetVersion,
          checks: run.results.map(r => ({ scenarioId: r.scenarioId, checkId: 'calendar_workflow',
            outcome: r.outcome === 'product_failure' ? 'failed' as const : r.outcome,
            evidenceIds: [`calendar:${r.scope.runId}`] })) },
      });
    },
  };
}
