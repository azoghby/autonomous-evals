import type { CheckpointLookup, CheckpointValue } from '../../../evals/integration/checkpoints.js';
import type { EvaluationDataTask } from '../../../evals/data/acquisition.js';
import type { CostEntry } from '../../../evals/types.js';
import type { ChatScope, ProgressSnapshot, TrustedAccessPort } from '../types.js';

/** Inventories are resolved from authorized durable job metadata, never client JSON. */
export interface ProjectionPlan {
  scope: ChatScope;
  environment: 'test' | 'live';
  checkpoints: Array<{
    key: CheckpointLookup & { inputDigest: string };
    phase: 'planning' | 'running' | 'investigating';
    format: 'text_design' | 'text_run' | 'calendar_run' | 'text_investigation' | 'calendar_investigation';
    /** Expected persisted run/suite associations, required for run formats. */
    runId?: string;
    suiteDigest?: string;
    branchId?: string;
    scenarioIds?: readonly string[];
  }>;
  acquisitionTaskIds: readonly string[];
}
export interface DurableProgressRead {
  scope: ChatScope;
  /** Consistency watermark from durable storage; never Date.now(). */
  observedAt: string;
  job: { jobId: string; status: ProgressSnapshot['status']; updatedAt: string };
  /** Exactly one entry for every planned key, including missing rows as null. */
  checkpoints: Array<{ key: CheckpointLookup & { inputDigest: string }; record: CheckpointValue | null }>;
  acquisition: Array<{ taskId: string; record: EvaluationDataTask | null }>;
  /** Complete authorized job ledger, not a cross-tenant or truncated list. */
  costs: CostEntry[];
  unknownCosts: boolean;
}
export interface ProgressProjectionPorts {
  access: TrustedAccessPort;
  resolve(scope: ChatScope): Promise<ProjectionPlan | null>;
  /** One consistent read. Verify key digests, retain scope on all queries. No writes/retries. */
  reader: { read(plan: ProjectionPlan): Promise<DurableProgressRead> };
  /** Server-only stable secret for HMAC references (at least 32 UTF-8 bytes). */
  referenceKey: string;
  knownSecrets?: readonly string[] | (() => readonly string[]);
}
export type ProjectedOutcome = 'passed' | 'product_failure' | 'rubric_concern' | 'inconclusive' | 'infrastructure_error' | 'not_assessed' | 'error';
export interface GroundedProgressProjection {
  snapshot: ProgressSnapshot;
  phases: Array<{ evidenceRef: string; phase: ProjectionPlan['checkpoints'][number]['phase']; state: 'missing' | 'pending' | 'ambiguous' | 'completed' | 'blocked'; outcomes: ProjectedOutcome[] }>;
  acquisition: Array<{ evidenceRef: string; state: EvaluationDataTask['state'] | 'missing'; phase: EvaluationDataTask['phase'] | null }>;
}
