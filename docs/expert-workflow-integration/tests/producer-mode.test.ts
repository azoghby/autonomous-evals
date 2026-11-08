import { afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ build: vi.fn(), pool: vi.fn() }));
vi.mock('@ae/core/integration/eval-services', () => ({ buildAgentDeps: m.build }));
vi.mock('@neondatabase/serverless', () => ({ Pool: m.pool }));
// All owner/session modules are isolated; no network or app database can be reached.
vi.mock('@/server/automated-expert-owner', () => ({ createOwnerExpertStep: vi.fn() }));
vi.mock('@/server/automated-expert-responses', () => ({ createSqlExpertResponseService: vi.fn() }));
vi.mock('@/server/session', () => ({ getCurrentCustomer: vi.fn() }));
vi.mock('@/server/job-store', () => ({ recordCost: vi.fn(), jobKnownCostMicroUsd: vi.fn() }));
import { advanceExpertProductionData } from '@/server/expert-data-production';
afterEach(() => vi.unstubAllEnvs());
it('EVAL_SERVICES=lite refuses before database access or agent construction/dispatch', async () => {
  vi.stubEnv('EVAL_SERVICES', 'lite');
  await expect(advanceExpertProductionData('job', {} as never, 'topic')).rejects.toThrow('expert_real_mode_not_active');
  expect(m.build).not.toHaveBeenCalled(); expect(m.pool).not.toHaveBeenCalled();
});
