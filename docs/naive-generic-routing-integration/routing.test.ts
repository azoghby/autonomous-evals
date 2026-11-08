import { describe, it, expect, vi } from 'vitest';
import type { EvalServices, ServiceContext } from '@ae/core/contracts/services';
import { EvalServiceUnavailableError, TrackBPendingError } from '@ae/core/integration/eval-services';
import { readRoutingSelection, routeNaiveMethods, requireNaivePackage } from './postimages/apps/web/src/server/naive-method-routing';
const ctx = { budgetMicroUsd: 100 } as ServiceContext;
const selection = readRoutingSelection({ EVAL_SERVICES: 'real', EVAL_NAIVE_METHODS: 'designSuite' });
describe('generic Naive routing candidate', () => {
  it.each(['designSuite,', 'all', 'designSuite,designSuite', ' designSuite'])('refuses malformed %s', raw => {
    expect(() => readRoutingSelection({ EVAL_SERVICES: 'real', EVAL_NAIVE_METHODS: raw })).toThrow();
  });
  it('rejects mode/branch configuration and unsupported packages', () => {
    expect(() => readRoutingSelection({ EVAL_SERVICES: 'lite', EVAL_NAIVE_METHODS: 'runSuite' })).toThrow();
    expect(() => readRoutingSelection({ EVAL_REAL_BRANCHES: 'true' })).toThrow();
    expect(() => requireNaivePackage('workflow_eval', selection)).toThrow();
    expect(() => requireNaivePackage('version_comparison', selection)).toThrow();
  });
  it('does not invoke legacy or construct selected services at zero/invalid budget', async () => {
    const old = vi.fn(); const builder = vi.fn();
    const routed = routeNaiveMethods({ designSuite: old } as unknown as EvalServices, {} as EvalServices, selection, builder);
    for (const budgetMicroUsd of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) await expect(routed.designSuite({ ...ctx, budgetMicroUsd }, {} as never)).rejects.toThrow();
    expect(old).not.toHaveBeenCalled(); expect(builder).not.toHaveBeenCalled();
  });
  it('selected unavailable never falls back and unrelated expert/legacy calls retain identity', async () => {
    const old = vi.fn(); const expert = vi.fn();
    const routed = routeNaiveMethods({ designSuite: old, runSuite: expert } as unknown as EvalServices, {} as EvalServices, selection, async () => { throw new EvalServiceUnavailableError('designSuite','missing'); });
    await expect(routed.designSuite(ctx, {} as never)).rejects.toThrow('missing');
    expect(old).not.toHaveBeenCalled(); expect(routed.runSuite).toBe(expert);
  });
  it('pending admission is terminal for step retries and identifiable as a hold', async () => {
    const routed = routeNaiveMethods({} as EvalServices, {} as EvalServices, selection, async () => { throw new TrackBPendingError(100, 'Generic text design admission pending.'); });
    await expect(routed.designSuite(ctx, {} as never)).rejects.toThrow('NAIVE_ADMISSION_PENDING:');
  });
  it('preserves provider pending identity for existing retry mapping', async () => {
    const pending = new TrackBPendingError(100, 'provider operation pending');
    const routed = routeNaiveMethods({} as EvalServices, {} as EvalServices, selection, async () => { throw pending; });
    await expect(routed.designSuite(ctx, {} as never)).rejects.toBe(pending);
  });
  it('invokes injected implementation and selects real branches separately', async () => {
    const build = vi.fn(async () => ({ designSuite: vi.fn(async () => 'suite') }));
    const createJobBranch = vi.fn(async () => ({ branchId: 'real', connectionString: 'secret' }));
    const routed = routeNaiveMethods({} as EvalServices, { createJobBranch, deleteJobBranch: vi.fn(), getJobBranchConnection: vi.fn() } as unknown as EvalServices, { ...selection, realBranches: true }, build as never);
    expect(await routed.designSuite(ctx, {} as never)).toBe('suite');
    expect(await routed.createJobBranch('job')).toMatchObject({ branchId: 'real' });
    expect(build).toHaveBeenCalledOnce();
  });
});
