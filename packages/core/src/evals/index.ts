/** Server-only composition entry point. Importing this module never creates clients,
 * reads credentials, authorizes a job, or selects mock/real services. */
export { createTrackBServices, TrackBPendingError, TrackBBlockedError, toContractCost, toContractFinding } from './service-adapter';
export type { TrackBServiceDeps } from './service-adapter';
export { createTextEvaluationServices, toLegacyRunResult } from './integration/services';
export { PostgresTextCheckpointStore } from './integration/checkpoints';
export { createCalendarEvaluationServices } from './calendar-integration';
export { createRemediationServices } from './remediation';
export type { RemediationDeps, AuthorizedRemediation, RemediationResult, AppliedReceipt } from './remediation';
export { createTargetServices } from '../targets/adapters';
export { createTextTarget } from '../targets/text';
export { createRemediationTarget } from '../targets/remediation';
export type { RemediationTargetDeps } from '../targets/remediation';
export { createBranchServices } from '../simulator/adapters';
export { AgentSessionService } from '../agents/session-service';
export { createPostgresAgentRuntime, withAgentCostDelivery } from '../agents/runtime';
export type { AgentCostSink } from '../agents/runtime';
export { PostgresAgentTaskStore, PostgresBudgetLedger } from '../agents/postgres-ports';
export { createPostgresEvaluationDataStore, createPostgresDataOperationLedger, acquireEvaluationData, advanceDataOrchestration, createAuthenticatedDataReviewLedger } from './data';
export type { PostgresDataOperationScope, DataOperationReconciliation } from './data';
export { createMediaWikiDiscovery } from './data/discovery';
export { createDiscoveryOperations, createPostgresDiscoveryOperations } from './data/discovery/persistence';
export { createProgressChatService, createPostgresConversationPort } from '../reporting/chat';
export { createDurableProgressProjection, createDurableProgressReader } from '../reporting/chat/projection';
export { renderCalendarReport } from '../reporting/calendar';
export { createComparisonMonitoringService, createTextComparisonAdapter, createCalendarComparisonAdapter, createRetainedComparisonAdapter } from '../monitoring';
export { createTrustedRegistry, freezePack, verifyPack, packReviewDigest, draftFromAppendedInventory, createPackExecutionService, comparePackRuns, createSecuredTextPackRunner, actualPackTargetDigest } from './packs';
