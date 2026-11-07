import type { EvaluationDataPorts } from '../acquisition';
import { createExpertRequestDraft, type ExpertRequestDraft } from '../expert';
import { inspectDataSafety } from '../quality';

/** Private artifact storage only. Upsert by operationKey and reject changed content on replay. */
export interface ExpertDraftStore {
  putIfAbsent(operationKey: string, draft: ExpertRequestDraft): Promise<void>;
}

/** No contribution approval, recipient selection, delivery, hiring, or spending capability. */
export function createDraftOnlyExpertAdapter(config: {
  drafts: ExpertDraftStore;
  knownSecrets?: readonly string[];
}): EvaluationDataPorts['expert'] {
  return async request => {
    if (!request.operationKey.trim() || request.operationKey.length > 512
      || !inspectDataSafety({ operationKey: request.operationKey, task: request.task }, config.knownSecrets).safe) {
      throw new Error('invalid_expert_draft_request');
    }
    // Rebuild the artifact; never trust an incoming draft's recipient/authority claims.
    const draft = createExpertRequestDraft({ requestId: request.operationKey, task: request.task }, config.knownSecrets);
    await config.drafts.putIfAbsent(request.operationKey, draft);
    return { status: 'pending' };
  };
}
