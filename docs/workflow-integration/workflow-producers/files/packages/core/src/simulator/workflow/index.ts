import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChatTarget } from '../../targets/chat.js';
import { isPersistableText } from '../../targets/chat.js';
import { CalendarSimulator, type CalendarState, type RunScope } from '../calendar.js';
import { gradeCalendarState, stateExpectationSchema } from '../graders.js';
import type { TransactionalDatabase } from '../postgres.js';
import { runCalendarScenario, compareCalendar, type CalendarExecution } from '../runner.js';

const id = z.string().min(1).max(128).refine(isPersistableText);
const text = z.string().min(1).max(20_000).refine(isPersistableText);
const instant = z.string().datetime().transform(s => new Date(s).toISOString());
const zone = id.refine(s => { try { new Intl.DateTimeFormat('en', { timeZone: s }); return s === 'UTC' || s.includes('/'); } catch { return false; } });
const event = z.object({ id, calendarId: id, ownerId: id, title: text, startUtc: instant, endUtc: instant, timeZone: zone, status: z.enum(['active', 'cancelled']) }).strict();
const seedSchema = z.object({
  calendars: z.array(z.object({ id, ownerId: id }).strict()).min(1).max(20),
  permissions: z.array(z.object({ calendarId: id, actorId: id, access: z.enum(['read','write']) }).strict()).max(100),
  events: z.array(event).max(100), calls: z.array(z.never()).max(0), failNextMutation: z.boolean(),
}).strict().superRefine((s, ctx) => {
  const calendars = new Set(s.calendars.map(c => c.id));
  if (calendars.size !== s.calendars.length || new Set(s.events.map(e => e.id)).size !== s.events.length ||
      new Set(s.permissions.map(p => JSON.stringify([p.calendarId,p.actorId]))).size !== s.permissions.length ||
      s.permissions.some(p => !calendars.has(p.calendarId)) || s.events.some(e => !calendars.has(e.calendarId) || Date.parse(e.startUtc) >= Date.parse(e.endUtc) || e.ownerId !== s.calendars.find(c => c.id === e.calendarId)?.ownerId)) {
    ctx.addIssue({ code: 'custom', message: 'invalid_seed_relationships' });
  }
});
const checks = z.array(stateExpectationSchema).min(1).max(100);
const scenarioSchema = z.object({ id, prompt: text, actorId: id, seed: seedSchema, checks, claimRequiredState: checks.optional() }).strict().refine(s => !s.claimRequiredState || s.claimRequiredState.some(c => c.kind === 'event' || (c.kind === 'matching_events' && c.expected > 0)), { message: 'claim_requires_action_identity_and_fields' });
const suiteSchema = z.object({
  jobId: id, frozenAt: z.string().datetime(), review: z.object({ reviewerId: id, approved: z.literal(true) }).strict(),
  origin: z.enum(['customer', 'internal_fixture']).default('customer'),
  scenarios: z.array(scenarioSchema).length(12),
}).strict().superRefine((s, ctx) => {
  if (new Set(s.scenarios.map(v => v.id)).size !== 12) ctx.addIssue({ code: 'custom', message: 'duplicate_scenario' });
});
export type WorkflowScenario = Omit<z.infer<typeof scenarioSchema>, 'seed'> & { seed: CalendarState };
export type FrozenCalendarSuite = Omit<z.infer<typeof suiteSchema>, 'scenarios'> & { scenarios: WorkflowScenario[]; hash: string };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) immutable(v); Object.freeze(value); }
  return value;
}
/** Review is supplied by the trusted investigator adapter, never inferred from scenario text. */
export type CalendarSuiteInput = Omit<z.input<typeof suiteSchema>, 'scenarios'> & { scenarios: WorkflowScenario[] };
export function freezeCalendarSuite(input: CalendarSuiteInput): FrozenCalendarSuite {
  const suite = suiteSchema.parse(input);
  return immutable({ ...suite, hash: createHash('sha256').update(canonical(suite)).digest('hex') });
}
function verifySuite(suite: FrozenCalendarSuite) {
  const { hash, ...body } = suite;
  const frozen = freezeCalendarSuite(body);
  if (hash !== frozen.hash) throw new Error('frozen_suite_mismatch');
  return frozen;
}
export type WorkflowOutcome = 'passed' | 'product_failure' | 'inconclusive' | 'infrastructure_error';
export interface WorkflowScenarioResult {
  scenarioId: string; scope: RunScope; outcome: WorkflowOutcome; reason: string;
  execution?: CalendarExecution;
  partialState?: CalendarState;
  stateGrade?: Awaited<ReturnType<typeof gradeCalendarState>>;
  claim?: 'success' | 'no_success' | 'unknown';
  claimGrade?: Awaited<ReturnType<typeof gradeCalendarState>>;
}
export interface CalendarWorkflowRun {
  jobId: string; branchId: string; runId: string; suiteHash: string; versionLabel: string;
  origin: 'customer' | 'internal_fixture'; systemPrompt?: string; results: WorkflowScenarioResult[];
}
export interface CalendarWorkflowDependencies {
  simulator: CalendarSimulator;
  /** Same branch/database as simulator. Transactions must pin a connection. */
  db: TransactionalDatabase;
  /** Return a fresh target per scenario. Production must use the existing secure target client. */
  targetForScenario(scenario: WorkflowScenario): ChatTarget | Promise<ChatTarget>;
  /** Trusted classifier; unknown or unavailable classification never proves false success. */
  classifySuccess?(execution: CalendarExecution, scenario: WorkflowScenario): Promise<'success' | 'no_success' | 'unknown'>;
}
interface RunInput {
  /** Optional stable parent operation identity, durably fenced by the integration factory. */
  runId?: string;
  suite: FrozenCalendarSuite; versionLabel: string; branchId: string; systemPrompt?: string; dependencies: CalendarWorkflowDependencies;
}
async function executeScenario(input: RunInput, scenario: WorkflowScenario): Promise<WorkflowScenarioResult> {
  const scope = { jobId: input.suite.jobId, runId: randomUUID(), version: input.versionLabel };
  const base = { scenarioId: scenario.id, scope };
  let execution: CalendarExecution;
  try {
    const target = await input.dependencies.targetForScenario(structuredClone(scenario));
    execution = await runCalendarScenario({ simulator: input.dependencies.simulator, target, scope, scenarioId: scenario.id,
      actorId: scenario.actorId, prompt: scenario.prompt, seed: structuredClone(scenario.seed), systemPrompt: input.systemPrompt });
  } catch {
    // The runner may fail before returning (create/snapshot). Preserve readable partial state,
    // but never fabricate a transcript or expose driver/target exceptions containing credentials.
    let partialState: CalendarState | undefined;
    try { partialState = await input.dependencies.simulator.store.snapshot(scope); } catch { /* No readable state. */ }
    return { ...base, partialState, outcome: 'infrastructure_error', reason: 'execution_unavailable' };
  }
  if (execution.stopped !== 'complete') return { ...base, execution, outcome: execution.stopped === 'invalid_response' || execution.stopped === 'round_limit' ? 'inconclusive' : 'infrastructure_error', reason: execution.stopped };
  let stateGrade: WorkflowScenarioResult['stateGrade'];
  let claimGrade: WorkflowScenarioResult['claimGrade'];
  try {
    await input.dependencies.db.transaction(async tx => {
      await tx.query('SELECT 1 FROM sim_runs WHERE job_id=$1 AND run_id=$2 AND version=$3 FOR UPDATE', [scope.jobId, scope.runId, scope.version]);
      stateGrade = await gradeCalendarState(tx, scope, scenario.checks);
      if (scenario.claimRequiredState) claimGrade = await gradeCalendarState(tx, scope, scenario.claimRequiredState);
    });
  } catch { return { ...base, execution, outcome: 'infrastructure_error', reason: 'sql_grading_unavailable' }; }
  let claim: WorkflowScenarioResult['claim'] = 'unknown';
  if (scenario.claimRequiredState && input.dependencies.classifySuccess) {
    try { claim = await input.dependencies.classifySuccess(structuredClone(execution), structuredClone(scenario)); }
    catch { /* Unknown is retained. */ }
    if (!['success', 'no_success', 'unknown'].includes(claim) || !execution.messages.filter(m => m.role === 'assistant').at(-1)?.content?.trim()) claim = 'unknown';
  }
  const evidence = { ...base, execution, stateGrade, claim, claimGrade };
  if (!stateGrade!.passed) return { ...evidence, outcome: 'product_failure', reason: 'state_mismatch' };
  if (scenario.claimRequiredState && claim === 'unknown') return { ...evidence, outcome: 'inconclusive', reason: 'claim_not_assessed' };
  if (claim === 'success' && claimGrade && !claimGrade.passed) return { ...evidence, outcome: 'product_failure', reason: 'false_success' };
  return { ...evidence, outcome: 'passed', reason: 'sql_checks_passed' };
}
async function execute(input: RunInput, scenarios: WorkflowScenario[]): Promise<CalendarWorkflowRun> {
  id.parse(input.versionLabel); id.parse(input.branchId);
  if (input.runId !== undefined) id.parse(input.runId);
  if (input.systemPrompt !== undefined) z.string().max(20_000).refine(isPersistableText).parse(input.systemPrompt);
  const run: CalendarWorkflowRun = { jobId: input.suite.jobId, branchId: input.branchId, runId: input.runId ?? randomUUID(), suiteHash: input.suite.hash,
    versionLabel: input.versionLabel, origin: input.suite.origin, systemPrompt: input.systemPrompt, results: [] };
  // Sequential dispatch is intentionally within the transport's two-request global bound.
  for (const scenario of scenarios) run.results.push(await executeScenario(input, scenario));
  return immutable(run);
}
export async function runCalendarSuite(input: RunInput): Promise<CalendarWorkflowRun> {
  const suite = verifySuite(input.suite);
  return execute({ ...input, suite }, suite.scenarios);
}
function verifyRun(suite: FrozenCalendarSuite, run: CalendarWorkflowRun) {
  verifySuite(suite);
  if (run.suiteHash !== suite.hash || run.jobId !== suite.jobId || run.origin !== suite.origin ||
      new Set(run.results.map(r => r.scenarioId)).size !== run.results.length || run.results.some(r =>
        !suite.scenarios.some(s => s.id === r.scenarioId) || r.scope.jobId !== run.jobId || r.scope.version !== run.versionLabel ||
        (r.execution && (canonical(r.scope) !== canonical(r.execution.scope) || r.scenarioId !== r.execution.scenarioId)))) throw new Error('run_suite_mismatch');
}
/** One selected scenario on current authorized target; returns original evidence unchanged. */
export async function rerunCalendarFinding(input: { suite: FrozenCalendarSuite; run: CalendarWorkflowRun; scenarioId: string; dependencies: CalendarWorkflowDependencies; branchId?: string }) {
  input = { ...input, suite: verifySuite(input.suite), run: immutable(structuredClone(input.run)) };
  verifyRun(input.suite, input.run);
  if (!input.run.results.some(r => r.scenarioId === input.scenarioId)) throw new Error('scenario_not_in_run');
  const scenario = input.suite.scenarios.find(s => s.id === input.scenarioId)!;
  const rerun = await execute({ suite: input.suite, versionLabel: input.run.versionLabel, branchId: input.branchId ?? input.run.branchId,
    systemPrompt: input.run.systemPrompt, dependencies: input.dependencies }, [scenario]);
  return { original: structuredClone(input.run), rerun };
}
export function compareFrozenCalendarRuns(a: CalendarWorkflowRun, b: CalendarWorkflowRun) {
  if (a.suiteHash !== b.suiteHash || a.jobId !== b.jobId || a.origin !== b.origin ||
      canonical(a.results.map(r => r.scenarioId).sort()) !== canonical(b.results.map(r => r.scenarioId).sort())) throw new Error('comparison_suite_mismatch');
  return { suiteHash: a.suiteHash, statisticalSignificance: 'not_assessed' as const, differences: a.results.map(left => {
    const right = b.results.find(r => r.scenarioId === left.scenarioId)!;
    return { scenarioId: left.scenarioId, outcomes: [left.outcome, right.outcome],
      state: left.execution && right.execution ? compareCalendar(left.execution, right.execution) : undefined };
  }) };
}
/** Refuses lossy conversion: caller must extend Track A contracts or explicitly handle unknowns. */
export function toTrackAWorkflowRun(run: CalendarWorkflowRun) {
  if (run.results.some(r => r.outcome === 'inconclusive' || r.outcome === 'infrastructure_error')) throw new Error('workflow_outcome_contract_gap');
  return { runId: run.runId, versionLabel: run.versionLabel, results: run.results.map(r => ({ scenarioId: r.scenarioId, passed: r.outcome === 'passed', detail: r.reason })) };
}

export interface WorkflowReproduction { originalScenarioId: string; result: WorkflowScenarioResult }
export interface WorkflowFinding {
  id: string; scenarioId: string; title: string; description: string;
  status: 'confirmed' | 'inconclusive'; severity: 'medium';
  category: 'state_mismatch' | 'false_success' | 'other'; reproductions: number;
  outcome: WorkflowOutcome;
  evidence: Array<{ kind: 'response' | 'state_diff'; excerpt: string; location: string }>;
  association: { jobId: string; branchId: string; suiteHash: string; scope: RunScope; reproductionScope?: RunScope };
}
export interface WorkflowInvestigationRecord {
  original: CalendarWorkflowRun;
  attempts: Array<{ scenarioId: string; result?: WorkflowScenarioResult }>;
}
export interface WorkflowInvestigationJournal {
  /** Serialize this key across processes, including calls, and release on throw. */
  withLock<T>(key: string, action: () => Promise<T>): Promise<T>;
  load(key: string): Promise<WorkflowInvestigationRecord | undefined>;
  /** Durably commit before resolving, especially attempt intent before dispatch. */
  save(key: string, record: WorkflowInvestigationRecord): Promise<void>;
}
/** Local fixtures only. Production supplies a durable journal with cross-process locking. */
export class MemoryWorkflowInvestigationJournal implements WorkflowInvestigationJournal {
  private records = new Map<string, WorkflowInvestigationRecord>();
  private locks = new Map<string, Promise<void>>();
  async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(key, current);
    await previous;
    try { return await action(); } finally { release(); if (this.locks.get(key) === current) this.locks.delete(key); }
  }
  async load(key: string) { const r = this.records.get(key); return r ? structuredClone(r) : undefined; }
  async save(key: string, record: WorkflowInvestigationRecord) { this.records.set(key, structuredClone(record)); }
}
function findings(record: WorkflowInvestigationRecord): WorkflowFinding[] {
  return record.original.results.filter(r => r.outcome !== 'passed').map(result => {
    const reproduction = record.attempts.find(a => a.scenarioId === result.scenarioId)?.result;
    const failedChecks = (r: WorkflowScenarioResult) => canonical((r.reason === 'false_success' ? r.claimGrade : r.stateGrade)?.results.filter(c => !c.passed).map(c => c.check));
    const repeated = result.outcome === 'product_failure' && reproduction?.outcome === 'product_failure' && result.reason === reproduction.reason && failedChecks(result) === failedChecks(reproduction);
    const association = { jobId: record.original.jobId, branchId: record.original.branchId, suiteHash: record.original.suiteHash,
      scope: result.scope, reproductionScope: reproduction?.scope };
    const location = `calendar:${result.scope.runId}`;
    const evidence: WorkflowFinding['evidence'] = [{ kind: 'state_diff', location,
      excerpt: JSON.stringify({ outcome: result.outcome, reason: result.reason, claim: result.claim, stateGrade: result.stateGrade, claimGrade: result.claimGrade,
        reproduction: reproduction && { outcome: reproduction.outcome, reason: reproduction.reason, stateGrade: reproduction.stateGrade, claimGrade: reproduction.claimGrade } }).slice(0, 10_000) }];
    const response = result.execution?.messages.filter(m => m.role === 'assistant').at(-1);
    if (response) evidence.push({ kind: 'response', location, excerpt: JSON.stringify(response).slice(0, 10_000) });
    return { id: createHash('sha256').update(`${record.original.runId}:${result.scenarioId}`).digest('hex').slice(0, 32),
      scenarioId: result.scenarioId, title: `Calendar ${result.reason}`, description: repeated ? 'The same objective failure was observed in the original execution and one isolated reproduction.' : 'Original evidence retained; a matching objective reproduction has not been established.',
      status: repeated ? 'confirmed' : 'inconclusive', severity: 'medium', category: result.reason === 'false_success' ? 'false_success' : result.reason === 'state_mismatch' ? 'state_mismatch' : 'other',
      reproductions: reproduction ? 1 : 0, outcome: result.outcome, association, evidence };
  });
}
/** Three candidate product failures, each once. Unknown/transport failures are never retried here. */
export async function investigateCalendarRun(input: {
  suite: FrozenCalendarSuite; run: CalendarWorkflowRun; dependencies: CalendarWorkflowDependencies; journal: WorkflowInvestigationJournal;
}) {
  input = { ...input, suite: verifySuite(input.suite), run: immutable(structuredClone(input.run)) };
  verifyRun(input.suite, input.run);
  const key = `calendar-investigation:${input.run.jobId}:${input.run.runId}`;
  return input.journal.withLock(key, async () => {
    let record = await input.journal.load(key);
    if (record && canonical(record.original) !== canonical(input.run)) throw new Error('investigation_original_mismatch');
    if (!record) {
      record = { original: structuredClone(input.run), attempts: [] };
      await input.journal.save(key, record);
    }
    for (const candidate of record.original.results.filter(r => r.outcome === 'product_failure').slice(0, 3)) {
      if (record.attempts.some(a => a.scenarioId === candidate.scenarioId)) continue;
      const attempt: WorkflowInvestigationRecord['attempts'][number] = { scenarioId: candidate.scenarioId };
      record.attempts.push(attempt);
      // A crash after intent is ambiguous: retain a pending attempt and never auto-dispatch it again.
      await input.journal.save(key, record);
      const scenario = input.suite.scenarios.find(s => s.id === candidate.scenarioId)!;
      attempt.result = await executeScenario({ suite: input.suite, versionLabel: input.run.versionLabel, branchId: input.run.branchId,
        systemPrompt: input.run.systemPrompt, dependencies: input.dependencies }, scenario);
      await input.journal.save(key, record);
    }
    return immutable({ original: structuredClone(record.original),
      reproductions: record.attempts.filter((a): a is typeof a & { result: WorkflowScenarioResult } => !!a.result)
        .map(a => ({ originalScenarioId: a.scenarioId, result: a.result })),
      pendingScenarioIds: record.attempts.filter(a => !a.result).map(a => a.scenarioId), findings: findings(record) });
  });
}
