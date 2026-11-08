import { z } from 'zod';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import type { AgentTaskRunner } from '@ae/core/agents/session-service';
import type { ExpertLoopScope } from '@ae/core/evals/data/adapters/automated-expert';
import { createNaiveExpertResponseExtractor, mapQuestionnaireResponse, questionnaireResponseDigest,
  type OwnerExpertResponseMetadata, type QuestionnaireAnswerRecord, type ExpertResponseCandidateResult } from '@ae/core/evals/data/adapters/expert-response';
import { QuestionnaireAnswers } from '@ae/core/contracts/experts';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { inspectDataSafety } from '@ae/core/evals/data/quality';
import type { DataTaskSpec } from '@ae/core/evals/data/types';
import type { CostEntry, JobRef } from '@ae/core/evals/types';

export interface SqlExpertResponseOptions {
  scope: ExpertLoopScope;
  tenantId: string;
  topic: string;
  runner: AgentTaskRunner;
  job: JobRef;
  sessionCapMicroUsd: number;
  jobCapMicroUsd: number;
  onMeasuredCost(entry: { taskKey: string; cost: CostEntry }): Promise<void>;
  /** Resolve current server-owned secret policy on reads and again after every model/cost await. */
  knownSecrets?: () => readonly string[];
}
export type SqlExpertResponseRead = { status: 'pending'; reason: string } | {
  status: 'received'; response: QuestionnaireAnswerRecord; metadata: OwnerExpertResponseMetadata;
};
const useSchema = z.enum(['evaluation', 'generation', 'redistribution']);
const sourceSchema = z.object({ url: z.string(), retrievedAt: z.string(), license: z.object({
  name: z.string(), url: z.string(), permission: z.enum(['allowed', 'denied', 'unknown', 'mixed']), allowedUses: z.array(useSchema),
}).strict() }).strict();
const rowSchema = z.object({
  request_id: z.string(), response_id: z.string(), engagement_id: z.string(), expert_id: z.string(),
  answers: QuestionnaireAnswers.shape.answers, provenance: z.literal('expert_sourced'),
  created_at: z.string(), questions: z.array(z.string().min(1)).min(1).max(8),
  evidence: z.array(z.string().min(1)).min(1), allowed_uses: z.array(useSchema), consent_receipt: z.string(),
  contribution_source: sourceSchema.nullable(),
});

/** Real owner-side SQL ingestion, with no grant inferred from signup contact consent or prose.
 * Existing free text questionnaires lack contribution licensing: the nullable owner grant is
 * intentionally required before extraction. All results are candidates awaiting independent review.
 */
export function createSqlExpertResponseService(sql: AgentTransactionalSql, options: SqlExpertResponseOptions) {
  const scope = structuredClone(options.scope);
  const tenantId = options.tenantId, topic = options.topic;
  const knownSecrets = () => [...(options.knownSecrets?.() ?? [])];
  const pending = (reason: string): { status: 'pending'; reason: string } => ({ status: 'pending', reason });
  const safeId = (v: string) => typeof v === 'string' && v.length > 0 && v.length <= 1024 && inspectDataSafety(v, knownSecrets()).safe;

  async function read(deliveryId: string): Promise<SqlExpertResponseRead> {
    if (![scope.operationId, scope.jobId, scope.taskId, scope.requestHash, tenantId, topic, deliveryId].every(safeId)) return pending('unsafe_response_scope');
    return sql.transaction(async tx => {
      // Check current authority independently of whether the response exists; don't expose private
      // existence information to a stale/revoked workflow. No private name/email/token is selected.
      const authority = await tx.query(`SELECT o.request_id FROM expert_automation_operations o
        JOIN expert_automation_scopes s ON s.job_id=o.job_id AND s.task_id=o.task_id
          AND s.tenant_id=o.tenant_id AND s.request_hash=o.request_hash
        JOIN jobs j ON j.id=o.job_id AND j.customer_id=o.tenant_id
        JOIN expert_automation_policies p ON p.id=s.policy_id
        JOIN expert_automation_invitations i ON i.operation_id=o.operation_id
        JOIN expert_engagements g ON g.id=i.engagement_id AND g.request_id=o.request_id AND g.expert_id=i.expert_id
        JOIN expert_requests r ON r.id=o.request_id AND r.job_id=o.job_id
        WHERE o.operation_id=$1 AND o.job_id=$2 AND o.task_id=$3 AND o.tenant_id=$4
          AND o.request_hash=$5 AND s.topic=$6 AND i.engagement_id=$7
          AND s.enabled AND p.enabled AND p.job_cap_micro_usd=25000000 AND p.daily_cap_micro_usd=50000000
          AND i.promised AND i.send_state='sent'`,
      [scope.operationId, scope.jobId, scope.taskId, tenantId, scope.requestHash, topic, deliveryId]);
      if (authority.rows.length !== 1) return pending('response_authority_unavailable');
      const result = await tx.query(`SELECT o.request_id::text,r.id::text AS response_id,g.id::text AS engagement_id,
          e.id::text AS expert_id,r.answers,r.provenance,
          to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
          q.evidence,q.allowed_uses,q.consent_receipt,q.contribution_source,req.questions
        FROM expert_automation_operations o
        JOIN expert_automation_invitations i ON i.operation_id=o.operation_id
        JOIN expert_engagements g ON g.id=i.engagement_id AND g.request_id=o.request_id AND g.expert_id=i.expert_id
        JOIN expert_requests req ON req.id=o.request_id AND req.job_id=o.job_id
        JOIN expert_responses r ON r.engagement_id=g.id
        JOIN experts e ON e.id=g.expert_id
        JOIN expert_automation_qualifications q ON q.expert_id=e.id AND q.topic=$6
        WHERE o.operation_id=$1 AND o.job_id=$2 AND o.task_id=$3 AND o.tenant_id=$4 AND o.request_hash=$5
          AND i.engagement_id=$7 AND i.send_state='sent' AND i.promised AND g.status IN ('answered','paid')
          AND e.status='active' AND q.qualified
          AND NOT EXISTS(SELECT 1 FROM contact_suppressions x WHERE lower(x.email)=lower(e.email))`,
      [scope.operationId, scope.jobId, scope.taskId, tenantId, scope.requestHash, topic, deliveryId]);
      // Multiple historical submissions are ambiguous, never silently choose latest/first.
      if (result.rows.length !== 1) return pending('response_missing_or_ambiguous');
      const parsed = rowSchema.safeParse(result.rows[0]);
      if (!parsed.success) return pending('owner_response_evidence_missing');
      const row = parsed.data;
      if (!row.contribution_source) return pending('source_permission_missing');
      const response: QuestionnaireAnswerRecord = { id: row.response_id, engagementId: row.engagement_id,
        answers: row.answers, provenance: row.provenance, createdAt: row.created_at };
      const digest = questionnaireResponseDigest(response);
      const metadata: OwnerExpertResponseMetadata = { requestId: row.request_id, taskId: scope.taskId, jobId: scope.jobId,
        engagementId: row.engagement_id, responseId: row.response_id, responseDigest: digest,
        contributorId: row.expert_id,
        questions: row.questions, qualificationEvidence: row.evidence,
        // These fields are authenticated operator grants in the qualifications table, not contact consent.
        consent: { evaluation: row.allowed_uses.includes('evaluation'), allowedUses: row.allowed_uses, receiptUrl: row.consent_receipt },
        source: row.contribution_source };
      if (!inspectDataSafety({ response, metadata }, knownSecrets()).safe) return pending('unsafe_response');
      await tx.query(`INSERT INTO expert_automation_response_bindings(operation_id,engagement_id,response_id,response_digest)
        VALUES($1,$2,$3,$4) ON CONFLICT(operation_id,engagement_id) DO NOTHING`, [scope.operationId, deliveryId, row.response_id, digest]);
      const retained = await tx.query<{ response_id: string; response_digest: string }>(
        'SELECT response_id::text,response_digest FROM expert_automation_response_bindings WHERE operation_id=$1 AND engagement_id=$2', [scope.operationId, deliveryId]);
      if (retained.rows.length !== 1 || retained.rows[0]!.response_id !== row.response_id || retained.rows[0]!.response_digest !== digest) return pending('response_identity_changed');
      return { status: 'received', response, metadata };
    });
  }

  async function extract(task: DataTaskSpec, deliveryId: string): Promise<ExpertResponseCandidateResult> {
    task = structuredClone(task);
    if (task.jobId !== scope.jobId || task.taskId !== scope.taskId || task.jobId !== options.job.jobId) return pending('response_task_mismatch');
    const first = await read(deliveryId);
    if (first.status === 'pending') return first;
    const before = mapQuestionnaireResponse(task, first.metadata, first.response, { cases: [] }, knownSecrets());
    if (before.status !== 'pending' || before.reason !== 'extraction_missing') return before;
    const extractor = createNaiveExpertResponseExtractor({ runner: options.runner, job: options.job,
      sessionCapMicroUsd: options.sessionCapMicroUsd, jobCapMicroUsd: options.jobCapMicroUsd,
      onMeasuredCost: options.onMeasuredCost, knownSecrets: knownSecrets() });
    const result = await extractor(task, first.metadata, first.response);
    // Cost delivery and extraction both await external systems. Re-read current SQL authority,
    // qualification/consent/source grants and safety policy before returning any private candidates.
    const current = await read(deliveryId);
    if (current.status === 'pending') return current;
    if (reviewDigest(first) !== reviewDigest(current)) return pending('response_metadata_changed');
    if (!inspectDataSafety({ task, result, current }, knownSecrets()).safe) return pending('unsafe_response');
    return result;
  }
  return { read, extract };
}
