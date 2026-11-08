import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../contracts/services';
import { createNaiveMethodServices, type NaiveMethodServiceDeps } from './naive-services';
import { TrackBBlockedError } from './service-adapter';

describe('concrete Naive method composition', () => {
  const ctx = (budgetMicroUsd: number) => ({ jobId: '11111111-1111-4111-8111-111111111111', environment: 'test', budgetMicroUsd, recordCost: vi.fn(), recordProgress: vi.fn() }) as unknown as ServiceContext;
  it.each([0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid paid admission %s before every owner port', async budget => {
    const invoked = vi.fn(() => { throw new Error('owner port must not run'); });
    const deps = {
      design: { authorize: invoked }, run: { resolve: invoked }, investigation: { resolve: invoked },
      remediation: { resolve: invoked }, rerun: { resolve: invoked },
    } as unknown as NaiveMethodServiceDeps;
    const services = createNaiveMethodServices(deps);
    for (const method of Object.values(services)) {
      await expect((method as (...args: unknown[]) => Promise<unknown>)(ctx(budget), undefined, undefined)).rejects.toMatchObject({ code: 'paused_budget' });
    }
    expect(invoked).not.toHaveBeenCalled();
  });
  it('propagates the actual remediation resolver refusal without alternate execution', async () => {
    const refusal = new TrackBBlockedError('needs_operator', 'Canonical baseline unavailable');
    const resolve = vi.fn(async () => { throw refusal; });
    const services = createNaiveMethodServices({ design: {}, run: {}, investigation: {}, rerun: {}, remediation: { resolve } } as unknown as NaiveMethodServiceDeps);
    const context = ctx(300_000);
    await expect(services.proposeAndVerifyFix(context, { finding: { id: 'canonical-id' } } as never)).rejects.toBe(refusal);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(context, 'canonical-id');
    expect(context.recordCost).not.toHaveBeenCalled();
  });
});
