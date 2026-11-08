import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { composeEvalServices, EvalServiceUnavailableError } from './src/integration/compose';
import { createLiteServices, LITE_NO_DATABASE } from './src/lite';
import { decodeDetail, type LiteDeps } from './src/lite/deps';
import { Suite, IntakeInput } from './src/contracts';
import type { EvalServices, ServiceContext } from './src/contracts/services';
import { withLiteFallback, evalServicesMode, toWorkflowError, getEvalServices } from './app/services';
import { TrackBBlockedError, TrackBPendingError } from './src/evals/service-adapter';
import { evaluateObjectiveCheck } from './src/evals/text/objective';
import { FatalError, RetryableError } from './boundaries/workflow';
import { EvalServiceConfigError } from './boundaries/bootstrap';

// Tripwires: any accidental production HTTP/DNS/fetch path fails this offline run.
vi.mock('node:https', () => ({ request: () => { throw new Error('OFFLINE_HTTPS_FORBIDDEN'); } }));
vi.mock('node:dns/promises', () => ({ lookup: () => { throw new Error('OFFLINE_DNS_FORBIDDEN'); } }));
vi.stubGlobal('fetch', () => { throw new Error('OFFLINE_FETCH_FORBIDDEN'); });

const unavailable = ['designSuite','runSuite','investigate','proposeAndVerifyFix','rerunFinding'] as const;
const ctx = (budgetMicroUsd = 100_000): ServiceContext => ({ jobId: '00000000-0000-4000-8000-000000000001', environment: 'test', budgetMicroUsd, recordCost: async () => {}, recordProgress: async () => {} });
const target = { url: 'https://fixture.invalid/v1', model: 'offline-fixture', systemPrompt: '' };
const intake = IntakeInput.parse({ package: 'text_eval', authorizedToTest: true, endpoint: target });
const scenario = { id: 'S01', title: 'Required text', category: 'format', input: 'Return REQUIRED', checks: [{ kind: 'objective' as const, description: 'Must contain REQUIRED', spec: { type: 'contains', value: 'REQUIRED', case_sensitive: true } }] };
const suite = () => Suite.parse({ jobId: ctx().jobId, versionLabel: 'v1', frozenAt: '2026-11-07T00:00:00Z', scenarios: [scenario] });
function primary() {
  const agents = vi.fn(async (): Promise<never> => { throw new EvalServiceConfigError('OFFLINE_AGENTS'); });
  const branches = vi.fn(async (): Promise<never> => { throw new Error('OFFLINE_BRANCHES'); });
  return { services: composeEvalServices({ agents, branches }), agents, branches };
}
function lite(passed = true) {
  const calls: unknown[] = [];
  const post = vi.fn(async (_url: string, body: unknown): Promise<unknown> => { calls.push(body); return { choices: [{ message: { role: 'assistant', content: 'WRONG' }, finish_reason: 'stop' }] }; });
  // Explicit fixture response, validated with the schema supplied by real lite code.
  const generateStructured: LiteDeps['generateStructured'] = async args => ({ object: args.schema.parse(args.agent === 'investigator' ? { findings: [] } : { passed, reason: 'Fixture judgment' }), text: '', provider: 'vercel', model: 'fixture', inputTokens: 0, outputTokens: 0, microUsd: 0, costBasis: 'list_price_estimate', latencyMs: 0 });
  return { services: createLiteServices({ generateStructured, transport: { post }, now: () => new Date('2026-11-07T00:00:00Z') }), post, calls };
}

describe('ACCEPTANCE — composition boundaries only', () => {
  it('S01 real composition explicitly gates all five unavailable methods before provider initialization', async () => {
    const p = primary();
    for (const method of unavailable) {
      const call = p.services[method] as unknown as () => unknown;
      expect(() => call()).toThrow(EvalServiceUnavailableError);
      const map = JSON.parse(readFileSync('service-map.json','utf8'));
      try { call(); } catch (e) { expect(e).toMatchObject({ method, retryable: false, reason: map.methods[method].reason }); }
    }
    expect(p.agents).not.toHaveBeenCalled(); expect(p.branches).not.toHaveBeenCalled();
  });
  it('S02 configured agent path remains lazy and config failure retries initialization without fallback', async () => {
    const p = primary(); const fallback = lite(); const hybrid = withLiteFallback(p.services, fallback.services);
    for (let i = 0; i < 2; i++) await expect(hybrid.qualify(ctx(), intake, [])).rejects.toBeInstanceOf(EvalServiceConfigError);
    expect(p.agents).toHaveBeenCalledTimes(2); expect(fallback.post).not.toHaveBeenCalled();
  });
  it('S03 branch methods delegate and share initialization without substituting lite placeholders', async () => {
    const branch = { branchId: 'owned-fixture', connectionString: 'postgres://offline-placeholder' };
    const branches = vi.fn(async () => ({ createJobBranch: vi.fn(async () => branch), deleteJobBranch: vi.fn(async () => {}), getJobBranchConnection: vi.fn(async () => branch.connectionString) }));
    const services = composeEvalServices({ agents: primary().agents, branches });
    expect(await services.createJobBranch('job')).toEqual(branch);
    expect(await services.getJobBranchConnection!('owned-fixture')).toBe(branch.connectionString);
    await services.deleteJobBranch('owned-fixture'); expect(branches).toHaveBeenCalledTimes(1);
  });
  it('S04 real target validation refuses HTTP locally without initializing agents/branches', async () => {
    const p = primary(); expect(await p.services.checkTarget(ctx(), { url: 'http://localhost', model: 'fixture' })).toMatchObject({ ok: false });
    expect(p.agents).not.toHaveBeenCalled(); expect(p.branches).not.toHaveBeenCalled();
  });
  it('S05 actual app wrapper falls back only on unavailable, preserving pending/blocked/config/ordinary errors', async () => {
    for (const error of [new TrackBPendingError(100,'pending'), new TrackBBlockedError('needs_operator','blocked'), new EvalServiceConfigError('missing'), new Error('ordinary')]) {
      const fallback = lite(); const p = { ...primary().services, designSuite: async (): Promise<never> => { throw error; } };
      await expect(withLiteFallback(p,fallback.services).designSuite(ctx(),intake)).rejects.toBe(error);
      expect(fallback.post).not.toHaveBeenCalled();
    }
    expect(toWorkflowError(new TrackBPendingError(100,'pending'))).toBeInstanceOf(RetryableError);
    expect(toWorkflowError(new EvalServiceUnavailableError('runSuite','gap'))).toBeInstanceOf(FatalError);
  });
});

describe('CHARACTERIZATION — observed behavior, NOT full Track B acceptance', () => {
  it('S06 actual app real selection serves gated design through lite template at zero budget', async () => {
    const previous = process.env.EVAL_SERVICES;
    try {
      process.env.EVAL_SERVICES = 'real';
      const result = await (await getEvalServices()).designSuite(ctx(0),intake);
      expect(result.scenarios.filter(s => !s.id.startsWith('rt_'))).toHaveLength(6);
      expect(result.scenarios.some(s => s.id.startsWith('rt_'))).toBe(true);
    } finally { if (previous === undefined) delete process.env.EVAL_SERVICES; else process.env.EVAL_SERVICES = previous; }
  });
  it('S07 lite branches are inert placeholders and refuse foreign branch deletion', async () => {
    const l = lite(); const branch = await l.services.createJobBranch(ctx().jobId);
    expect(branch.connectionString).toBe(LITE_NO_DATABASE);
    expect(await l.services.getJobBranchConnection!(branch.branchId)).toBe('lite://no-database');
    await l.services.deleteJobBranch(branch.branchId);
    await expect(l.services.deleteJobBranch('real-owned-branch')).rejects.toThrow('not a lite branch');
    expect(l.post).not.toHaveBeenCalled();
  });
  it('S08 lite transport loss becomes passed:false error detail, excluded by investigator', async () => {
    const l = lite(); l.post.mockRejectedValue(new Error('offline loss'));
    const hybrid = withLiteFallback(primary().services,l.services);
    const run = await hybrid.runSuite(ctx(),suite(),target);
    expect(run.results[0]?.passed).toBe(false); expect(decodeDetail(run.results[0]!.detail)?.grader).toBe('error');
    expect(await hybrid.investigate(ctx(),suite(),[run])).toEqual([]);
    expect(l.post).toHaveBeenCalledTimes(1);
  });
  it('S09 lite ordinary objective spec is judged by fixture LLM while real B objective evaluator fails it', async () => {
    const l = lite(true); const run = await withLiteFallback(primary().services,l.services).runSuite(ctx(),suite(),target);
    expect(run.results[0]?.passed).toBe(true); expect(decodeDetail(run.results[0]!.detail)?.grader).toBe('judge');
    expect(evaluateObjectiveCheck({ id: 'o1', kind: 'objective', description: 'required', spec: { type: 'contains', value: 'REQUIRED', case_sensitive: true } }, 'WRONG').status).toBe('fail');
  });
  it('S10 recreating lite services redispatches and repeats counter-based run identity', async () => {
    const first = lite(); const a = await first.services.runSuite(ctx(),suite(),target);
    const second = lite(); const b = await second.services.runSuite(ctx(),suite(),target);
    expect(a.runId).toBe(b.runId); expect(first.post).toHaveBeenCalledTimes(1); expect(second.post).toHaveBeenCalledTimes(1);
  });
  it('S11 lite tool calls receive unavailable stub rather than executing calendar SQL', async () => {
    const l = lite();
    l.post.mockImplementationOnce(async (_url, body) => { l.calls.push(body); return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'book', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }; });
    const s = suite(); s.scenarios[0]!.checks[0]!.spec = { turns: ['Book', 'Was it booked?'] };
    await l.services.runSuite(ctx(),s,target);
    expect(l.calls).toHaveLength(2);
    const body = l.calls[1] as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.some(m => m.role === 'tool' && m.content.includes('tool execution unavailable in eval'))).toBe(true);
    expect(body).not.toHaveProperty('tools');
  });
  it('S12 lite factual rubric without reference can pass rather than expose not_assessed', async () => {
    const l = lite(); const s = suite(); s.scenarios[0]!.checks = [{ kind: 'rubric', description: 'Factual correctness against reference', spec: { factual: true } }];
    const run = await l.services.runSuite(ctx(),s,target);
    expect(run.results[0]?.passed).toBe(true); expect(decodeDetail(run.results[0]!.detail)?.grader).toBe('judge');
    if (intake.package !== 'text_eval') throw new Error('fixture package');
    expect(intake.endpoint).not.toHaveProperty('referenceText');
  });
  it('S13 mode defaults to mock and real error mapping does not make missing services available', () => {
    const previous = process.env.EVAL_SERVICES;
    try { delete process.env.EVAL_SERVICES; expect(evalServicesMode()).toBe('mock'); process.env.EVAL_SERVICES='unknown'; expect(evalServicesMode()).toBe('mock'); }
    finally { if (previous === undefined) delete process.env.EVAL_SERVICES; else process.env.EVAL_SERVICES=previous; }
  });
  it('S14 machine map covers every actual contract method and every Track B requirement, with pinned blob provenance', () => {
    const map = JSON.parse(readFileSync('service-map.json','utf8'));
    expect(map.trackA).toBe('8634ceb30f3d98de7ec24b240a4f7549dce80033');
    expect(Object.keys(map.methods).sort()).toEqual(Object.keys(primary().services).sort());
    expect(Object.keys(map.methods).filter(k => map.methods[k].real === 'unavailable').sort()).toEqual([...unavailable].sort());
    expect(map.requirements.map((r: { id: string }) => r.id)).toEqual(Array.from({length:10},(_,i)=>`B${i+1}`));
    for (const row of [...Object.values(map.methods), ...map.requirements] as Array<{ release: string; evidence: string[]; gate: string }>) {
      expect(row.release).toBe('gated'); expect(row.gate.length).toBeGreaterThan(10); expect(row.evidence.length).toBeGreaterThan(0);
      for (const id of row.evidence) expect(id).toMatch(/^S(0[1-9]|1[0-4])$/);
    }
    const blobs = JSON.parse(readFileSync('snapshots.json','utf8'));
    for (const path of ['apps/web/src/server/services.ts','packages/core/src/integration/compose.ts','packages/core/src/lite/index.ts']) expect(blobs.some((b: {path:string;blob:string}) => b.path === path && /^[0-9a-f]{40}$/.test(b.blob))).toBe(true);
  });
});
