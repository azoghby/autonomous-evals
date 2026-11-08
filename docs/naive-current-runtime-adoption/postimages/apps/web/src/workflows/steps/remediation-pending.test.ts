import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  propose: vi.fn(), progress: vi.fn(), assertCurrent: vi.fn(), saveFindings: vi.fn(),
  saveRemediation: vi.fn(), pending: vi.fn(), complete: vi.fn(), stages: [] as unknown[],
}));
vi.mock('workflow', () => ({
  FatalError: class FatalError extends Error {}, RetryableError: class RetryableError extends Error {},
}));
vi.mock('@ae/core/db/client', () => ({ db: vi.fn(), schema: {} }));
vi.mock('@ae/core/storage/blob', () => ({ putJobArtifact: vi.fn() }));
vi.mock('@/server/branch-connection', () => ({ resolveBranchConnection: vi.fn() }));
vi.mock('@/server/workflow-stage-runtime', () => ({ assertWorkflowStageCurrent: mocks.assertCurrent }));
vi.mock('@/server/job-store', () => ({
  findingRowIdByKey: vi.fn(async () => 'row'), recordProgress: mocks.progress,
  saveFindings: mocks.saveFindings, saveRemediation: mocks.saveRemediation, setJobState: vi.fn(),
}));
vi.mock('@/server/services', async () => {
  const { RetryableError, FatalError } = await import('workflow');
  return {
    getEvalServices: async () => ({ proposeAndVerifyFix: mocks.propose }),
    isWorkflowStagePendingError: (error: unknown) => error instanceof RetryableError,
    isWorkflowStageControlError: (error: unknown) => error instanceof RetryableError || error instanceof FatalError || (error instanceof Error && /^(workflow_stage_|job_cancellation_)/.test(error.message)),
    workflowServiceCall: async (run: () => Promise<unknown>) => run(),
    recoverableEvalStage: vi.fn(),
  };
});
vi.mock('./common', () => ({
  loadIntake: vi.fn(async () => ({ package: 'trace_audit' })), requireJob: vi.fn(),
  withBudget: async (_job: string, _role: string, stage: { isPendingError?: (error: unknown) => boolean }, run: (ctx: unknown) => Promise<unknown>) => {
    mocks.stages.push(stage);
    try {
      const data = await run({ recordProgress: mocks.progress });
      mocks.complete(data);
      return { status: 'ok', data };
    } catch (error) {
      if (stage.isPendingError?.(error)) mocks.pending(error);
      throw error;
    }
  },
}));

import { FatalError, RetryableError } from 'workflow';
import type { Finding } from '@ae/core/contracts/index';
import { proposeFixStep } from './evaluate';

const finding = { id: 'finding-1', title: 'Finding' } as Finding;
describe('remediation pending and publication boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.stages.length = 0; mocks.assertCurrent.mockResolvedValue(undefined); });
  it('throws converted pending to the stage predicate without completion, failure note or saves', async () => {
    const pending = new RetryableError('sensitive pending detail');
    mocks.propose.mockRejectedValueOnce(pending);
    await expect(proposeFixStep('job', finding)).rejects.toBe(pending);
    expect(mocks.pending).toHaveBeenCalledWith(pending);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.saveFindings).not.toHaveBeenCalled();
    expect(mocks.saveRemediation).not.toHaveBeenCalled();
    expect(mocks.progress.mock.calls.some(([milestone]) => milestone === 'fix_failed')).toBe(false);
    expect(mocks.stages[0]).not.toHaveProperty('recovery');
  });
  it('propagates fatal control flow without treating it as a verified failure', async () => {
    const error = new FatalError('blocked'); mocks.propose.mockRejectedValueOnce(error);
    await expect(proposeFixStep('job', finding)).rejects.toBe(error);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.progress).toHaveBeenCalledTimes(1);
  });
  it('does not swallow ownership failure from within the service', async () => {
    const error = new Error('workflow_stage_conflict'); mocks.propose.mockRejectedValueOnce(error);
    await expect(proposeFixStep('job', finding)).rejects.toBe(error);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.progress).toHaveBeenCalledTimes(1);
  });
  it('does not convert lost ownership during publication to null', async () => {
    const error = new Error('workflow_stage_conflict');
    mocks.propose.mockResolvedValueOnce({ id: 'fix' }); mocks.assertCurrent.mockRejectedValueOnce(error);
    await expect(proposeFixStep('job', finding)).rejects.toBe(error);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.saveRemediation).not.toHaveBeenCalled();
    expect(mocks.progress).toHaveBeenCalledTimes(1);
  });
  it('permits definitive failure as null with a sanitized progress note', async () => {
    mocks.propose.mockRejectedValueOnce(new Error('private provider detail'));
    await expect(proposeFixStep('job', finding)).resolves.toEqual({ status: 'ok', data: null });
    expect(mocks.complete).toHaveBeenCalledWith(null);
    expect(mocks.progress).toHaveBeenLastCalledWith('fix_failed', 'Could not verify a fix for finding finding-1.');
    expect(mocks.saveRemediation).not.toHaveBeenCalled();
  });
});
