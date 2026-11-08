import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getJob: vi.fn(), active: vi.fn(), finalize: vi.fn(), cancellation: vi.fn(), alert: vi.fn(), progress: vi.fn(), setState: vi.fn() }));
vi.mock('@ae/core/db/client', () => ({ db: vi.fn(), schema: {} }));
vi.mock('@/server/job-store', () => ({
  getJob: mocks.getJob, addMessage: vi.fn(), recordProgress: mocks.progress, setJobState: mocks.setState,
  setJobStateIfActive: mocks.active, finalizeJobCancellation: mocks.finalize,
}));
vi.mock('@/server/job-cancellation', () => ({ getJobCancellation: mocks.cancellation }));
vi.mock('@/server/operator-alerts', () => ({ alertOperators: mocks.alert }));
import { cancelStep, declineStep, deliverStep, failStep, pauseBudgetStep, setStateStep } from './lifecycle';

describe('cancellation-aware lifecycle', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.getJob.mockResolvedValue(null); mocks.active.mockResolvedValue(true); mocks.cancellation.mockResolvedValue(null); });
  it('delegates state and progress to one atomic active-state write', async () => {
    const progress = { milestone: 'running', message: 'Running' };
    await expect(setStateStep('job', 'running', progress)).resolves.toBe(true);
    expect(mocks.active).toHaveBeenCalledWith('job', 'running', progress);
    expect(mocks.setState).not.toHaveBeenCalled(); expect(mocks.progress).not.toHaveBeenCalled();
  });
  it('uses idempotent cancellation finalization without releasing provider holds', async () => {
    await cancelStep('job', 'reason'); await cancelStep('job', 'reason');
    expect(mocks.finalize).toHaveBeenCalledTimes(2);
    expect(mocks.finalize).toHaveBeenCalledWith('job', 'reason');
    expect(mocks.setState).not.toHaveBeenCalled(); expect(mocks.progress).not.toHaveBeenCalled();
  });
  it('a retained request turns a late failure into cancellation without an operator failure alert', async () => {
    mocks.cancellation.mockResolvedValue({ reason: 'original reason' });
    await expect(failStep('job', 'failure')).resolves.toBe('cancelled');
    expect(mocks.finalize).toHaveBeenCalledWith('job', 'original reason');
    expect(mocks.active).not.toHaveBeenCalled(); expect(mocks.alert).not.toHaveBeenCalled();
  });
  it('handles cancellation arriving between failure lookup and atomic transition', async () => {
    mocks.active.mockResolvedValue(false);
    mocks.cancellation.mockResolvedValueOnce(null).mockResolvedValueOnce({ reason: 'racing cancellation' });
    await expect(failStep('job', 'failure')).resolves.toBe('cancelled');
    expect(mocks.finalize).toHaveBeenCalledWith('job', 'racing cancellation');
    expect(mocks.alert).not.toHaveBeenCalled();
  });
  it('returns cancelled for an already cancelled legacy job without a marker', async () => {
    mocks.active.mockResolvedValue(false); mocks.getJob.mockResolvedValue({ state: 'cancelled' });
    await expect(failStep('job', 'late failure')).resolves.toBe('cancelled');
    expect(mocks.alert).not.toHaveBeenCalled();
  });
  it('budget pause routes marked cancellation through workflow cancellation control flow', async () => {
    mocks.cancellation.mockResolvedValue({ reason: 'original reason' });
    await expect(pauseBudgetStep('job', 'budget')).rejects.toThrow('job_cancellation_requested');
    expect(mocks.finalize).toHaveBeenCalledWith('job', 'original reason'); expect(mocks.alert).not.toHaveBeenCalled();
  });
  it('declines using one atomic cancelled state and progress write', async () => {
    await declineStep('job', 'decline reason');
    expect(mocks.active).toHaveBeenCalledWith('job', 'cancelled', { milestone: 'declined', message: 'This request was not accepted.' }, { error: 'decline reason' });
    expect(mocks.setState).not.toHaveBeenCalled(); expect(mocks.progress).not.toHaveBeenCalled();
  });
  it('replays committed delivery timestamp after a lost acknowledgement', async () => {
    mocks.active.mockResolvedValue(false);
    mocks.getJob.mockResolvedValue({ state: 'delivered', deliveredAt: new Date('2026-11-08T01:00:00.000Z') });
    await expect(deliverStep('job')).resolves.toEqual({ deliveredAtIso: '2026-11-08T01:00:00.000Z' });
    expect(mocks.progress).not.toHaveBeenCalled();
  });
  it('delivery rejection prevents a delivered result and progress note', async () => {
    mocks.active.mockResolvedValue(false);
    await expect(deliverStep('job')).rejects.toThrow('job_cancellation_requested');
    expect(mocks.active).toHaveBeenCalledWith('job', 'delivered', { milestone: 'delivered', message: 'Your report is ready.' }, expect.objectContaining({ deliveredAt: expect.any(Date) }));
    expect(mocks.progress).not.toHaveBeenCalled();
  });
});
