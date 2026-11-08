import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ discard: vi.fn(), db: vi.fn() }));
vi.mock('@ae/core/db/client', () => ({ db: mocks.db, schema: {} }));
vi.mock('@/server/job-store', () => ({ discardPartialJobEvaluation: mocks.discard }));
import { discardPartialEvaluationStep } from './resume';
describe('restart cleanup cancellation boundary', () => {
  beforeEach(() => vi.clearAllMocks());
  it('delegates deletion and progress to the atomic job-store authority', async () => {
    mocks.discard.mockResolvedValueOnce({ findings: 2, remediations: 1 });
    await expect(discardPartialEvaluationStep('job')).resolves.toEqual({ findings: 2, remediations: 1 });
    expect(mocks.discard).toHaveBeenCalledExactlyOnceWith('job');
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it('propagates cancellation instead of continuing with an empty result', async () => {
    const error = new Error('job_cancellation_requested'); mocks.discard.mockRejectedValueOnce(error);
    await expect(discardPartialEvaluationStep('job')).rejects.toBe(error);
    expect(mocks.db).not.toHaveBeenCalled();
  });
});
