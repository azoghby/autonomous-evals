/**
 * Branch lifecycle and simulator compatibility with Track A's contracts. In-memory and injected fakes only:
 * no Neon API, database, credentials, or network.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Scenario, Suite } from '../contracts/index';
import type { EvalServices, RunResult } from '../contracts/services';
import {
  CalendarSimulator, MemoryCalendarStore, calendarAcceptanceScenarios, calendarSeed, createBranchServices, runCalendarScenario,
  stateExpectationSchema, type BranchOwnership, type CalendarExecution, type NeonBranchService,
} from '../simulator/index.js';
import type { ChatTarget } from '../targets/index.js';

// Compile-time compatibility: the branch factory must satisfy the exact Track A service shapes.
type BranchServices = ReturnType<typeof createBranchServices>;
const asTrackA = (services: BranchServices): Pick<EvalServices, 'createJobBranch' | 'deleteJobBranch'> => services;
export type BranchServicesCompatible = typeof asTrackA;

// Method-style signatures are bivariant, so pin variance explicitly in both directions.
type Assert<T extends true> = T;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type BranchVariance = [
  Assert<Mutual<Parameters<EvalServices['createJobBranch']>, Parameters<BranchServices['createJobBranch']>>>,
  Assert<Mutual<Awaited<ReturnType<EvalServices['createJobBranch']>>, Awaited<ReturnType<BranchServices['createJobBranch']>>>>,
  Assert<Mutual<Parameters<EvalServices['deleteJobBranch']>, Parameters<BranchServices['deleteJobBranch']>>>,
  Assert<Mutual<Awaited<ReturnType<EvalServices['deleteJobBranch']>>, Awaited<ReturnType<BranchServices['deleteJobBranch']>>>>,
];

const jobId = '22222222-2222-4222-8222-222222222222';
const branchResult = z.object({ branchId: z.string().regex(/^br-[a-z0-9-]+$/), connectionString: z.string().startsWith('postgres') }).strict();
const owned = (overrides: Partial<BranchOwnership> = {}): BranchOwnership => ({ jobId, projectId: 'proj-1', parentId: 'br-seed', name: 'eval-job-1', branchId: 'br-job1', state: 'ready', ...overrides });

function harness(options: { record?: BranchOwnership; uri?: string } = {}) {
  const calls = { created: [] as string[], deleted: [] as string[] };
  const service = {
    createJobBranch: async (id: string) => { calls.created.push(id); return options.record ?? owned(); },
    deleteJobBranch: async (id: string) => { calls.deleted.push(id); return { state: 'deleted' as const }; },
  } as unknown as NeonBranchService;
  const services = createBranchServices({
    service,
    findOwnedBranch: async (branchId) => (options.record ?? owned()).branchId === branchId ? (options.record ?? owned()) : undefined,
    connectionString: async () => options.uri ?? 'postgres://branch-user:branch-secret@ep-1.example.neon.tech/db?sslmode=require',
  });
  return { calls, services: asTrackA(services) };
}

describe('branch services against Track A signatures', () => {
  it('returns the exact createJobBranch result shape', async () => {
    const { services, calls } = harness();
    expect(branchResult.parse(await services.createJobBranch(jobId))).toEqual({ branchId: 'br-job1', connectionString: expect.stringContaining('postgres://') });
    expect(calls.created).toEqual([jobId]);
  });

  it('rejects branches that are not ready or whose connection URI is not PostgreSQL', async () => {
    await expect(harness({ record: owned({ branchId: undefined, state: 'creating' }) }).services.createJobBranch(jobId)).rejects.toThrow('branch_not_ready');
    for (const uri of ['https://example.com/db', 'not a url', 'mysql://u:p@h/db']) {
      await expect(harness({ uri }).services.createJobBranch(jobId)).rejects.toThrow('invalid_branch_connection');
    }
  });

  it('deletes only through durable ownership, never from an arbitrary branch ID', async () => {
    const { services, calls } = harness();
    await expect(services.deleteJobBranch('br-someone-else')).rejects.toThrow('branch_not_owned');
    expect(calls.deleted).toEqual([]);
    await expect(services.deleteJobBranch('br-job1')).resolves.toBeUndefined();
    expect(calls.deleted).toEqual([jobId]);
  });

  it('KNOWN GAP: delete resolves void, so accepted-versus-confirmed deletion is not reportable to Track A', async () => {
    const { services } = harness();
    expect(await services.deleteJobBranch('br-job1')).toBeUndefined();
  });

  it('KNOWN GAP: create has no result state for creating/reconciliation, so those surface only as thrown errors', async () => {
    const { services } = harness({ record: owned({ branchId: undefined, state: 'creating' }) });
    await expect(services.createJobBranch(jobId)).rejects.toThrow(Error);
  });
});

describe('calendar acceptance scenarios mapped into the shared Scenario and Suite contracts', () => {
  const toContract = (scenario: ReturnType<typeof calendarAcceptanceScenarios>[number]) => ({
    id: scenario.id, title: scenario.id, category: 'calendar', input: scenario.prompt,
    checks: scenario.checks.map((spec, index) => ({ kind: 'state' as const, description: `${scenario.id} state check ${index + 1}`, spec })),
  });

  it('maps all twelve into a valid frozen Suite, and every state spec round-trips through the grader schema', () => {
    const scenarios = calendarAcceptanceScenarios();
    expect(scenarios).toHaveLength(12);
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(12);
    const suite = Suite.parse({ jobId, frozenAt: '2026-11-07T00:00:00.000Z', scenarios: scenarios.map(toContract) });
    expect(suite.scenarios).toHaveLength(12);
    for (const scenario of suite.scenarios) {
      expect(scenario.checks.every((check) => check.kind === 'state')).toBe(true);
      for (const check of scenario.checks) expect(stateExpectationSchema.safeParse(JSON.parse(JSON.stringify(check.spec))).success).toBe(true);
    }
  });

  it('rejects state specs outside the closed grader vocabulary even though the contract allows any record', () => {
    const generic = Scenario.parse({ id: 'x', title: 't', category: 'calendar', input: 'i', checks: [{ kind: 'state', description: 'd', spec: { kind: 'raw_sql', sql: 'DROP TABLE sim_events' } }] });
    expect(stateExpectationSchema.safeParse(generic.checks[0]!.spec).success).toBe(false);
    expect(stateExpectationSchema.safeParse({ kind: 'count', calendarId: 'personal', status: 'active', expected: 1, extra: true }).success).toBe(false);
  });

  it('KNOWN GAP: Scenario cannot carry the frozen seed or acting user, so contract parsing drops simulator state', () => {
    const [first] = calendarAcceptanceScenarios();
    const parsed = Scenario.parse({ ...toContract(first!), seed: first!.seed, actorId: first!.actorId }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('seed');
    expect(parsed).not.toHaveProperty('actorId');
    expect(first!.seed.events.length).toBeGreaterThan(0); // state exists for Track B but has no contract slot
  });
});

describe('execution outcomes versus the RunResult boolean', () => {
  const scripted = (...replies: Array<unknown>): ChatTarget => {
    let index = 0;
    return { complete: async () => { const next = replies[Math.min(index++, replies.length - 1)]; if (next instanceof Error) throw next; return next as never; } };
  };
  const toolRound = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_events', arguments: JSON.stringify({ calendarId: 'personal' }) } }] };
  const execute = (target: ChatTarget, runId: string) => runCalendarScenario({
    simulator: new CalendarSimulator(new MemoryCalendarStore()), target, scope: { jobId, runId, version: 'A' },
    scenarioId: 'list', actorId: 'alice', prompt: 'List my calendar', seed: calendarSeed(),
  });

  it('KNOWN GAP: four distinct stop reasons collapse into RunResult.passed', async () => {
    const executions: CalendarExecution[] = [
      await execute(scripted({ role: 'assistant', content: 'done' }), 'r-complete'),
      await execute(scripted(new Error('target down')), 'r-error'),
      await execute(scripted({ role: 'assistant', content: null }), 'r-invalid'),
      await execute(scripted(toolRound), 'r-limit'),
    ];
    expect(executions.map((e) => e.stopped)).toEqual(['complete', 'target_error', 'invalid_response', 'round_limit']);
    expect(executions[3]!.rounds).toBe(6);
    // The only Track A representation is { passed: boolean, detail }; infrastructure and inconclusive stops are not typed.
    const projected: RunResult['results'] = executions.map((e) => ({ scenarioId: e.scenarioId, passed: e.stopped === 'complete', detail: e.stopped }));
    expect(projected.filter((r) => !r.passed)).toHaveLength(3);
    expect(new Set(projected.filter((r) => !r.passed).map((r) => r.detail)).size).toBe(3);
  });
});
