/** Server-only composition entry point. Importing this module never creates clients,
 * reads credentials, authorizes a job, or selects mock/real services. */
export { createTrackBServices, TrackBPendingError, TrackBBlockedError, toContractCost, toContractFinding } from './service-adapter';
export type { TrackBServiceDeps } from './service-adapter';
export { createTextEvaluationServices, toLegacyRunResult } from './integration/services';
export { PostgresTextCheckpointStore } from './integration/checkpoints';
export { createCalendarEvaluationServices } from './calendar-integration';
export { createTargetServices } from '../targets/adapters';
export { createTextTarget } from '../targets/text';
export { createBranchServices } from '../simulator/adapters';
export { AgentSessionService } from '../agents/session-service';
export { PostgresAgentTaskStore, PostgresBudgetLedger } from '../agents/postgres-ports';
export { createPostgresEvaluationDataStore, acquireEvaluationData } from './data';
export { createMediaWikiDiscovery } from './data/discovery';
export { createProgressChatService, createPostgresConversationPort } from '../reporting/chat';
export { createDurableProgressProjection, createDurableProgressReader } from '../reporting/chat/projection';
export { renderCalendarReport } from '../reporting/calendar';
