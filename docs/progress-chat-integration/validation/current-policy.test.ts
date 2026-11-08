import { describe, expect, it } from 'vitest';
import { createProgressChatService } from '../packages/core/src/reporting/chat/service';
import type { ChatExchange, ProgressSnapshot } from '../packages/core/src/reporting/chat/types';

describe('combined patch current secret policy', () => {
  it('screens old immutable replies under a changed current policy, including replay/history/poll', async () => {
    const snapshot: ProgressSnapshot = { jobId: 'job-1', observedAt: '2026-11-07T20:00:00Z', status: 'running',
      statusEvidenceRef: 'opaque-evidence', milestones: [], findings: [], blockers: [], costs: [], unknownCosts: true };
    let secrets: string[] = [];
    let row: ChatExchange | null = null;
    const service = createProgressChatService({
      access: { authenticate: async () => ({subjectId: 'alice'}), resolveAuthorizedJob: async () => ({subjectId: 'alice', jobId: 'job-1'}) },
      progress: {read: async () => snapshot}, knownSecrets: () => secrets,
      conversations: {get: async () => row, append: async (_scope, input) => row = {...input, sequence: 1}, list: async () => row ? [row] : []},
    });
    const request = {jobId: 'job-1', messageId: 'message-1', question: 'progress'};
    await service.send(request);
    secrets = ['opaque-evidence'];
    for (const call of [() => service.send(request), () => service.history({jobId: 'job-1'}), () => service.poll({jobId: 'job-1'})]) {
      await expect(call()).rejects.toMatchObject({code: 'invalid_snapshot'});
    }
    expect(row?.sequence).toBe(1);
  });
});
