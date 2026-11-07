import { describe, expect, it } from 'vitest';
import { createDraftOnlyExpertAdapter } from './expert';
import { createExpertRequestDraft } from '../expert';
import { fixtureRequest } from './fixtures';

describe('draft only expert adapter', () => {
  it('rebuilds forged authority as an unsent draft and preserves the durable operation on replay', async () => {
    const request = fixtureRequest();
    request.expertDraft = createExpertRequestDraft({ requestId: 'forged', task: request.task });
    Object.assign(request.expertDraft, { recipient: 'forged-recipient', status: 'sent', outreachPolicy: { sendingApproved: true, spendApproved: true } });
    const records = new Map<string, unknown>(); const keys: string[] = [];
    const expert = createDraftOnlyExpertAdapter({ drafts: { async putIfAbsent(key, draft) {
      keys.push(key);
      if (records.has(key)) expect(draft).toEqual(records.get(key));
      else records.set(key, structuredClone(draft));
    } } });
    expect(await expert(request)).toEqual({ status: 'pending' });
    expect(await expert(request)).toEqual({ status: 'pending' });
    expect(keys).toEqual([request.operationKey, request.operationKey]);
    expect(records.get(request.operationKey)).toMatchObject({ requestId: request.operationKey, recipient: null, status: 'draft_not_sent', outreachPolicy: { recipientApproved: false, sendingApproved: false, spendApproved: false } });
  });
  it('refuses unsafe scope before writing any draft', async () => {
    let writes = 0;
    const expert = createDraftOnlyExpertAdapter({ drafts: { async putIfAbsent() { writes++; } }, knownSecrets: ['private-fixture-value'] });
    const request = fixtureRequest(); request.task.description = 'private-fixture-value';
    await expect(expert(request)).rejects.toThrow();
    expect(writes).toBe(0);
  });
});
