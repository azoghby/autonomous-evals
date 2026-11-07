import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { calendarAcceptanceScenarios } from '../acceptance-scenarios.js';
import { CalendarSimulator } from '../calendar.js';
import { PostgresCalendarStore, type TransactionalDatabase } from '../postgres.js';
import type { ChatTarget } from '../../targets/chat.js';
import {
  freezeCalendarSuite, runCalendarSuite, investigateCalendarRun,
  compareFrozenCalendarRuns, rerunCalendarFinding, MemoryWorkflowInvestigationJournal, toTrackAWorkflowRun,
  type WorkflowInvestigationRecord,
} from './index.js';

const acceptance = calendarAcceptanceScenarios();
const jobId = '38bc4f0d-6546-43ae-ae35-2c8a89230af8';
const suiteInput = () => ({
  jobId, origin: 'internal_fixture' as const, frozenAt: '2026-11-07T20:00:00.000Z',
  review: { reviewerId: 'internal-test-reviewer', approved: true as const },
  scenarios: acceptance.map(({ id, prompt, actorId, seed, checks }) => structuredClone({ id, prompt, actorId, seed, checks })),
});
const referenceTarget = (id: string): ChatTarget => {
  const scenario = acceptance.find(s => s.id === id)!;
  return { async complete(messages) {
    return messages.some(m => m.role === 'tool')
      ? { role: 'assistant', content: 'Reference sequence complete.' }
      : { role: 'assistant', content: null, tool_calls: structuredClone(scenario.referenceCalls) };
  } };
};
let pg: PGlite;
let db: TransactionalDatabase;
let simulator: CalendarSimulator;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(await readFile(new URL('../migrations/001_calendar.sql', import.meta.url), 'utf8'));
  db = {
    query: (sql, params) => pg.query(sql, params),
    transaction: fn => pg.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params) })),
  };
  simulator = new CalendarSimulator(new PostgresCalendarStore(db));
});
afterAll(async () => { await pg.close(); });
const deps = () => ({ simulator, db, targetForScenario: (s: { id: string }) => referenceTarget(s.id) });

it('freezes twelve reviewed scenarios with stable content identity and no caller-owned mutable seed', () => {
  const input = suiteInput();
  const frozen = freezeCalendarSuite(input);
  const duplicate = freezeCalendarSuite(suiteInput());
  expect(frozen.hash).toBe(duplicate.hash);
  input.scenarios[0].seed.events[0].title = 'caller mutation';
  expect(frozen.scenarios[0].seed.events[0].title).toBe('Team sync');
  expect(() => freezeCalendarSuite({ ...suiteInput(), scenarios: suiteInput().scenarios.slice(0, 11) })).toThrow();
  const repeated = suiteInput();
  repeated.scenarios[1].id = repeated.scenarios[0].id;
  expect(() => freezeCalendarSuite(repeated)).toThrow();
});

it('executes all twelve reference sequences and grades the actual PostgreSQL state', async () => {
  const suite = freezeCalendarSuite(suiteInput());
  const run = await runCalendarSuite({ suite, versionLabel: 'reference', branchId: 'branch-internal', dependencies: deps() });
  expect(run.results).toHaveLength(12);
  expect(run.results.map(r => r.outcome)).toEqual(Array(12).fill('passed'));
  expect(new Set(run.results.map(r => r.scope.runId)).size).toBe(12);
  for (const result of run.results) {
    const stored = await simulator.store.snapshot(result.scope);
    expect(stored).toEqual(result.execution!.state);
    expect(result.stateGrade!.passed).toBe(true);
  }
});

it('isolates repeated runs and versions, and compares only one frozen scenario suite', async () => {
  const suite = freezeCalendarSuite(suiteInput());
  const a = await runCalendarSuite({ suite, versionLabel: 'a', branchId: 'branch-internal', dependencies: deps() });
  const b = await runCalendarSuite({ suite, versionLabel: 'b', branchId: 'branch-internal', dependencies: deps() });
  const before = structuredClone(a);
  expect(a.results[0].scope).not.toEqual(b.results[0].scope);
  expect(compareFrozenCalendarRuns(a, b)).toBeDefined();
  await simulator.store.reset(b.results[0].scope);
  expect(await simulator.store.snapshot(a.results[0].scope)).toEqual(a.results[0].execution!.state);
  expect(a).toEqual(before);
  expect(() => compareFrozenCalendarRuns(a, { ...b, suiteHash: 'different' })).toThrow();
});

it('keeps target and SQL infrastructure errors distinct from product failures, and continues other scenarios', async () => {
  const suite = freezeCalendarSuite(suiteInput());
  const failingDb: TransactionalDatabase = {
    query: (sql, params) => db.query(sql, params),
    transaction: fn => db.transaction(tx => fn({
      async query(sql, params) {
        if (sql.startsWith('SELECT 1 FROM sim_runs') && params?.[2] === 'sql-failure') throw new Error('private connection string');
        return tx.query(sql, params);
      },
    })),
  };
  const run = await runCalendarSuite({ suite, versionLabel: 'partial', branchId: 'branch-internal', dependencies: {
    ...deps(), targetForScenario: s => s.id === 'booking'
      ? { async complete() { throw new Error('secret bearer token'); } } : referenceTarget(s.id),
  } });
  expect(run.results[0].outcome).toBe('infrastructure_error');
  expect(() => toTrackAWorkflowRun(run)).toThrow('workflow_outcome_contract_gap');
  expect(run.results.slice(1).every(r => r.outcome === 'passed')).toBe(true);
  expect(JSON.stringify(run)).not.toContain('secret bearer token');
  const sqlRun = await runCalendarSuite({ suite, versionLabel: 'sql-failure', branchId: 'branch-internal', dependencies: { ...deps(), db: failingDb } });
  expect(sqlRun.results.every(r => r.outcome === 'infrastructure_error')).toBe(true);
  expect(JSON.stringify(sqlRun)).not.toContain('private connection string');
});

it('repeats at most three candidate failures once, preserving all original evidence', async () => {
  const suite = freezeCalendarSuite(suiteInput());
  const dependencies = { ...deps(), targetForScenario: (): ChatTarget => ({ async complete() { return { role: 'assistant', content: 'No action taken.' }; } }) };
  const run = await runCalendarSuite({ suite, versionLabel: 'noop', branchId: 'branch-internal', dependencies });
  expect(run.results.filter(r => r.outcome === 'product_failure').length).toBeGreaterThan(3);
  const before = structuredClone(run);
  const journal = new MemoryWorkflowInvestigationJournal();
  const investigated = await investigateCalendarRun({ suite, run, dependencies, journal });
  const replayed = await investigateCalendarRun({ suite, run, dependencies, journal });
  expect(replayed).toEqual(investigated);
  expect(investigated.reproductions).toHaveLength(3);
  expect(new Set(investigated.reproductions.map(r => r.originalScenarioId)).size).toBe(3);
  for (const reproduction of investigated.reproductions) {
    const original = run.results.find(r => r.scenarioId === reproduction.originalScenarioId)!;
    expect(reproduction.result.scope.runId).not.toBe(original.scope.runId);
    expect(reproduction.result.outcome).toBe('product_failure');
  }
  expect(investigated.findings.length).toBeGreaterThan(0);
  expect(investigated.findings.every(f => f.evidence.length > 0)).toBe(true);
  expect(run).toEqual(before);
});

it('reruns a finding from frozen data under a new scope after original state is removed', async () => {
  const suite = freezeCalendarSuite(suiteInput());
  const run = await runCalendarSuite({ suite, versionLabel: 'replay', branchId: 'branch-internal', dependencies: deps() });
  const original = structuredClone(run);
  await simulator.store.reset(run.results[0].scope);
  const rerun = await rerunCalendarFinding({ suite, run, scenarioId: 'booking', dependencies: deps() });
  expect(rerun.rerun.results).toHaveLength(1);
  expect(rerun.rerun.results[0].scope.runId).not.toBe(run.results[0].scope.runId);
  expect(rerun.rerun.results[0].outcome).toBe('passed');
  expect(rerun.original).toEqual(original);
  expect(run).toEqual(original);
});

it('grades false success against the claimed action and keeps unknown classification inconclusive', async () => {
  const input = suiteInput();
  const claimState = acceptance[0].checks.filter(check => check.kind === 'matching_events');
  const suite = freezeCalendarSuite({ ...input, scenarios: input.scenarios.map(s => s.id === 'dependency-failure' ? { ...s, claimRequiredState: claimState } : s) });
  const claimed = await runCalendarSuite({ suite, versionLabel: 'false-success', branchId: 'branch-internal', dependencies: {
    ...deps(), classifySuccess: async () => 'success' as const,
  } });
  const failure = claimed.results.find(r => r.scenarioId === 'dependency-failure')!;
  expect(failure.stateGrade!.passed).toBe(true);
  expect(failure.outcome).toBe('product_failure');
  const unknown = await runCalendarSuite({ suite, versionLabel: 'unknown-claim', branchId: 'branch-internal', dependencies: {
    ...deps(), classifySuccess: async () => 'unknown' as const,
  } });
  expect(unknown.results.find(r => r.scenarioId === 'dependency-failure')!.outcome).toBe('inconclusive');
  const honest = await runCalendarSuite({ suite, versionLabel: 'honest-failure', branchId: 'branch-internal', dependencies: {
    ...deps(), classifySuccess: async () => 'no_success' as const,
  } });
  expect(honest.results.find(r => r.scenarioId === 'dependency-failure')!.outcome).toBe('passed');
});

it('retains invalid output and round exhaustion as inconclusive without product findings', async () => {
  const suite = freezeCalendarSuite(suiteInput());
  const invalid = await runCalendarSuite({ suite, versionLabel: 'invalid', branchId: 'branch-internal', dependencies: {
    ...deps(), targetForScenario: (): ChatTarget => ({ async complete() { return { role: 'assistant', content: '' }; } }),
  } });
  expect(invalid.results.every(r => r.outcome === 'inconclusive')).toBe(true);
  expect(invalid.results.every(r => r.execution?.stopped === 'invalid_response')).toBe(true);
  expect(() => toTrackAWorkflowRun(invalid)).toThrow('workflow_outcome_contract_gap');
  const bounded = await runCalendarSuite({ suite, versionLabel: 'round-limit', branchId: 'branch-internal', dependencies: {
    ...deps(), targetForScenario: (): ChatTarget => ({ async complete() { return {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'repeat-read', type: 'function', function: { name: 'list_events', arguments: '{"calendarId":"personal"}' } }],
    }; } }),
  } });
  expect(bounded.results.every(r => r.outcome === 'inconclusive')).toBe(true);
  expect(bounded.results.every(r => r.execution?.rounds === 6)).toBe(true);
  const investigation = await investigateCalendarRun({ suite, run: bounded, dependencies: deps(), journal: new MemoryWorkflowInvestigationJournal() });
  expect(investigation.reproductions).toHaveLength(0);
  expect(investigation.findings.every(f => f.status !== 'confirmed')).toBe(true);
});

it('serializes concurrent investigations so only three reproduction targets are dispatched', async () => {
  const suite = freezeCalendarSuite(suiteInput());
  let dispatches = 0;
  const dependencies = { ...deps(), targetForScenario: (): ChatTarget => {
    dispatches++;
    return { async complete() { return { role: 'assistant', content: 'No action taken.' }; } };
  } };
  const run = await runCalendarSuite({ suite, versionLabel: 'concurrent-investigation', branchId: 'branch-internal', dependencies });
  dispatches = 0;
  const journal = new MemoryWorkflowInvestigationJournal();
  const [a, b] = await Promise.all([
    investigateCalendarRun({ suite, run, dependencies, journal }),
    investigateCalendarRun({ suite, run, dependencies, journal }),
  ]);
  expect(dispatches).toBe(3);
  expect(a.reproductions).toHaveLength(3);
  expect(b).toEqual(a);
});

it('never redispatches an attempt whose intent save had an ambiguous response', async () => {
  const suite = freezeCalendarSuite(suiteInput());
  let dispatches = 0;
  const dependencies = { ...deps(), targetForScenario: (): ChatTarget => {
    dispatches++;
    return { async complete() { return { role: 'assistant', content: 'No action taken.' }; } };
  } };
  const run = await runCalendarSuite({ suite, versionLabel: 'ambiguous-investigation', branchId: 'branch-internal', dependencies });
  dispatches = 0;
  class AmbiguousJournal extends MemoryWorkflowInvestigationJournal {
    failed = false;
    override async save(key: string, record: WorkflowInvestigationRecord) {
      await super.save(key, record);
      if (!this.failed && record.attempts.length === 1 && !record.attempts[0].result) {
        this.failed = true;
        throw new Error('intent was committed but its acknowledgment was lost');
      }
    }
  }
  const journal = new AmbiguousJournal();
  await expect(investigateCalendarRun({ suite, run, dependencies, journal })).rejects.toThrow('acknowledgment was lost');
  expect(dispatches).toBe(0);
  const recovered = await investigateCalendarRun({ suite, run, dependencies, journal });
  expect(recovered.pendingScenarioIds).toEqual([run.results.find(r => r.outcome === 'product_failure')!.scenarioId]);
  expect(recovered.reproductions).toHaveLength(2);
  expect(dispatches).toBe(2);
  const again = await investigateCalendarRun({ suite, run, dependencies, journal });
  expect(again).toEqual(recovered);
  expect(dispatches).toBe(2);
});

it('rejects altered frozen content before dispatch and accepts the shared contract empty system prompt', async () => {
  const suite = freezeCalendarSuite(suiteInput());
  const altered = structuredClone(suite);
  altered.scenarios[0].seed.events[0].title = 'changed after review';
  let dispatches = 0;
  await expect(runCalendarSuite({ suite: altered, versionLabel: 'tampered', branchId: 'branch-internal', dependencies: {
    ...deps(), targetForScenario: s => { dispatches++; return referenceTarget(s.id); },
  } })).rejects.toThrow('frozen_suite_mismatch');
  expect(dispatches).toBe(0);
  const run = await runCalendarSuite({ suite, versionLabel: 'empty-system-prompt', branchId: 'branch-internal', systemPrompt: '', dependencies: deps() });
  expect(run.results.every(r => r.outcome === 'passed')).toBe(true);
  expect(run.results[0].execution!.messages[0]).toEqual({ role: 'system', content: '' });
});

it('distinguishes the existing buggy/fixed internal fixtures after injected dependency failure', async () => {
  const { internalCalendarFixture } = await import('../fixtures.js');
  const input = suiteInput();
  const booking = input.scenarios.find(s => s.id === 'booking')!;
  const required = booking.checks.filter(c => c.kind === 'matching_events');
  const suite = freezeCalendarSuite({ ...input, scenarios: input.scenarios.map(s => s.id === 'dependency-failure' ? { ...s, claimRequiredState: required } : s) });
  for (const mode of ['buggy', 'fixed'] as const) {
    const run = await runCalendarSuite({ suite, versionLabel: mode, branchId: 'fixture-branch', dependencies: {
      ...deps(), targetForScenario: s => s.id === 'dependency-failure'
        ? internalCalendarFixture(mode, acceptance.find(a => a.id === s.id)!.referenceCalls[0]) : referenceTarget(s.id),
      async classifySuccess(execution) {
        return execution.messages.at(-1)?.content === 'Booked successfully.' ? 'success' : 'no_success';
      },
    } });
    expect(run.results.find(s => s.scenarioId === 'dependency-failure')?.outcome).toBe(mode === 'buggy' ? 'product_failure' : 'passed');
  }
});

it('does not confirm a different SQL failure merely because both executions failed', async () => {
  const suite = freezeCalendarSuite(suiteInput());
  const run = await runCalendarSuite({ suite, versionLabel: 'different-failure', branchId: 'fixture-branch', dependencies: {
    ...deps(), targetForScenario: (): ChatTarget => ({ async complete() { return { role: 'assistant', content: 'No action.' }; } }),
  } });
  const checked = await investigateCalendarRun({ suite, run, journal: new MemoryWorkflowInvestigationJournal(), dependencies: {
    ...deps(), targetForScenario: s => {
      if (s.id !== 'booking') return referenceTarget(s.id);
      const call = structuredClone(acceptance.find(a => a.id === 'booking')!.referenceCalls[0]);
      call.function.arguments = JSON.stringify({ ...JSON.parse(call.function.arguments), title: 'Wrong title' });
      return { async complete(messages) {
        return messages.some(m => m.role === 'tool') ? { role: 'assistant', content: 'Done.' } : { role: 'assistant', content: null, tool_calls: [call] };
      } };
    },
  } });
  expect(checked.findings.find(f => f.scenarioId === 'booking')?.status).toBe('inconclusive');
});

it('preserves frozen identity and investigation idempotency through JSON persistence', async () => {
  const suite = freezeCalendarSuite({ ...suiteInput(), scenarios: suiteInput().scenarios.map(s => ({ ...s, claimRequiredState: undefined })) });
  const reloaded = JSON.parse(JSON.stringify(suite));
  const dependencies = { ...deps(), targetForScenario: (): ChatTarget => ({ async complete() { return { role: 'assistant', content: 'No action.' }; } }) };
  const run = await runCalendarSuite({ suite: reloaded, versionLabel: 'json-reload', branchId: 'fixture-branch', dependencies });
  const backing = new MemoryWorkflowInvestigationJournal();
  const journal = {
    withLock: backing.withLock.bind(backing),
    async load(key: string) { return backing.load(key); },
    async save(key: string, record: Parameters<typeof backing.save>[1]) { await backing.save(key, JSON.parse(JSON.stringify(record))); },
  };
  const first = await investigateCalendarRun({ suite: reloaded, run, dependencies, journal });
  const second = await investigateCalendarRun({ suite: reloaded, run: JSON.parse(JSON.stringify(run)), dependencies, journal });
  expect(second.reproductions).toEqual(first.reproductions);
});
