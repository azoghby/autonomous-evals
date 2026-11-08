import 'server-only';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { enqueueReviewResume } from './workflow-resumption';
import { createHash } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { pooledCalendarDatabase } from '@ae/core/simulator/pool';
import { buildAgentDeps } from './current-agent-deps';
import { decryptJson } from '@ae/core/storage/crypto';
import { createPostgresEvaluationDataStore } from '@ae/core/evals/data/postgres-store';
import { createPostgresDataOperationLedger } from '@ae/core/evals/data/postgres-operations';
import { createAuthenticatedDataReviewLedger } from '@ae/core/evals/data/review-ledger';
import { advanceDataOrchestration, createDataCostCapture } from '@ae/core/evals/data/orchestration';
import { createNaiveGenerationAdapter } from '@ae/core/evals/data/adapters/generation';
import { createDraftOnlyExpertAdapter } from '@ae/core/evals/data/adapters/expert';
import { createMediaWikiDiscovery } from '@ae/core/evals/data/discovery/index';
import { createPostgresDiscoveryOperations } from '@ae/core/evals/data/discovery/persistence/index';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { inspectDataSafety } from '@ae/core/evals/data/quality';
import { designTextSuite } from '@ae/core/evals/text/design';
import { verifyAdmittedFrozenSuite } from '@ae/core/evals/text/freeze';
import { CostEntrySchema, type CostEntry, type JobRef } from '@ae/core/evals/types';
import { toContractCost } from '@ae/core/evals/service-adapter';
import type { DataTaskSpec } from '@ae/core/evals/data/types';
import type { DataBatch } from '@ae/core/evals/data/acquisition';
import type { DataDesignContext } from '@ae/core/evals/data/adapters/mapping';
import { getCurrentCustomer } from './session';
import { upsertWorkflowCost } from './workflow-costs';

let pool: Pool | undefined;
function database() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('data_storage_unconfigured');
  pool ??= new Pool({ connectionString, max: 5 });
  return pooledCalendarDatabase(pool);
}
const identity = (value: string) => createHash('sha256').update(value).digest('hex');

/** Private server capability. Never export through a public route/action or accept customerId from a body. */
async function scoped(jobId: string, sql: AgentTransactionalSql = database()) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error('data_job_invalid');
  const rows = await sql.query<{ customer_id: string; package: string; environment: 'test' | 'live'; is_mock: boolean; retest_of_job_id: string | null }>(
    'SELECT customer_id, package, environment, is_mock, retest_of_job_id FROM jobs WHERE id=$1', [jobId]);
  const row = rows.rows[0];
  if (!row || row.package !== 'text_eval' || row.is_mock) throw new Error('data_job_unavailable');
  const credentials = await sql.query<{ ciphertext: string }>('SELECT ciphertext FROM job_credentials WHERE job_id=$1', [jobId]);
  const secretMap = credentials.rows[0] ? decryptJson<Record<string, string>>(credentials.rows[0].ciphertext) : {};
  if (!secretMap || Object.values(secretMap).some(v => typeof v !== 'string')) throw new Error('data_credentials_invalid');
  const secrets = [...Object.values(secretMap), ...Object.entries(process.env).filter(([k]) => /(?:KEY|TOKEN|SECRET|DATABASE_URL)$/.test(k)).map(([,v]) => v ?? '')].filter(Boolean);
  const ownerId = 'data_service_v1';
  const operations = createPostgresDataOperationLedger(sql, {
    tenantId: row.customer_id, jobId, ownerId, knownSecrets: secrets,
    authenticateOwner: async () => {
      const found = await sql.query('SELECT 1 FROM jobs WHERE id=$1 AND customer_id=$2 AND environment=$3 AND package=$4 AND is_mock=false', [jobId, row.customer_id, row.environment, 'text_eval']);
      return found.rows.length === 1 ? { ownerId } : null;
    },
    // No reconciliation endpoint: a different owner cannot complete or take over an ambiguous effect.
  });
  const job: JobRef = { jobId, customerId: row.customer_id, package: 'text_eval', environment: row.environment,
    quoteVersion: null, linkedRetestOf: row.retest_of_job_id, isFixture: false };
  async function durable(key: string, value: unknown) {
    const digest = reviewDigest(value);
    await operations.claim(key, digest);
    await operations.complete(key, digest, value);
  }
  async function deliverCost(cost: CostEntry) {
    cost = CostEntrySchema.parse(cost);
    if (cost.jobId !== jobId || !cost.measured || !cost.externalId || !inspectDataSafety(cost, secrets).safe) throw new Error('data_cost_invalid');
    const entry = toContractCost(cost);
    // Single global keyed sink shared with rich sessions; conflicts fail closed.
    await upsertWorkflowCost(sql, { ...entry, jobId });
  }
  const reviews = createAuthenticatedDataReviewLedger({ operations, knownSecrets: secrets, authenticateHuman: async task => {
    const human = await getCurrentCustomer();
    // Existing operator allowlist + real session; read-only job share/customer access does not grant review authority.
    if (!human?.isOperator || task.jobId !== jobId) return null;
    return { principalId: human.id };
  } });
  async function drainDesignCosts() {
    const keys = await sql.query<{ operation_key: string }>(
      "SELECT operation_key FROM evaluation_data_persistence.operations WHERE tenant_id=$1 AND job_id=$2 AND operation_key LIKE 'data-design-cost:%' ORDER BY operation_key LIMIT 1001", [row.customer_id, jobId]);
    if (keys.rows.length > 1000) throw new Error('data_cost_inventory_too_large');
    for (const { operation_key } of keys.rows) {
      const record = await operations.get(operation_key); // Includes current-secret and checksum validation.
      if (record?.state !== 'complete') throw new Error('data_cost_pending');
      await deliverCost(record.result as CostEntry);
    }
  }
  return { sql, operations, job, secrets, durable, deliverCost, reviews, drainDesignCosts };
}

export interface ProductionDataInput {
  task: DataTaskSpec;
  initial: DataBatch;
  context: Pick<DataDesignContext, 'versionLabel' | 'systemPrompt'>;
  /** Trusted operator configuration. Undefined means no discovery, not permission to search arbitrary URLs. */
  discovery?: { providerOrigin: string; queries: string[] };
}

/** Exact producer seam for the owning Workflow step. Input comes from its authorized durable job plan, never HTTP. */
export async function advanceProductionData(jobId: string, input: ProductionDataInput) {
  input = structuredClone(input);
  const s = await scoped(jobId);
  if (input.task.jobId !== jobId) throw new Error('data_scope_mismatch');
  await s.durable(`data-production-input:${input.task.taskId}`, input);
  await s.drainDesignCosts(); // Retry a lost cost acknowledgement even when freeze itself stays fenced.
  const { runner } = await buildAgentDeps();
  const generate = createNaiveGenerationAdapter({ runner, job: s.job, sessionCapMicroUsd: 250_000, jobCapMicroUsd: 3_000_000,
    knownSecrets: s.secrets, onMeasuredCost: createDataCostCapture(s.operations, s.secrets) });
  const discover = input.discovery ? createMediaWikiDiscovery({ ...input.discovery, knownSecrets: s.secrets,
    operations: createPostgresDiscoveryOperations({ db: s.sql, authenticatedScope: { tenantId: s.job.customerId, jobId }, knownSecrets: s.secrets }) }).discover
    : async () => ({ status: 'complete' as const, data: { sources: [], cases: [] } });
  const expert = createDraftOnlyExpertAdapter({ knownSecrets: s.secrets, drafts: { putIfAbsent: (key, draft) => s.durable(`expert-draft:${identity(key)}`, draft) } });
  return advanceDataOrchestration(input.task, input.initial, { ...input.context, job: s.job, knownSecrets: s.secrets }, {
    operations: s.operations, knownSecrets: s.secrets,
    acquisition: { store: createPostgresEvaluationDataStore(s.sql, { tenantId: s.job.customerId, jobId, knownSecrets: s.secrets }), discover, generate, expert },
    readReview: async request => {
      // Acquisition may not save merged candidates until review succeeds; publish the exact private immutable snapshot here.
      await s.durable(`data-review-request:${request.digest}`, { task: request.task, candidates: request.data });
      return s.reviews.readReview(request);
    },
    deliverCost: entry => s.deliverCost(entry.cost),
    freeze: async ({ mapping }) => {
      const outcome = await designTextSuite({ ...mapping.designInput, knownSecrets: s.secrets }, {
        runner: { run: async spec => {
          const result = await runner.run(spec);
          if ('cost' in result && result.cost) {
            await s.durable(`data-design-cost:${identity(result.taskKey)}`, result.cost);
            await s.deliverCost(result.cost);
          }
          return result;
        } }, budgetMicroUsd: 250_000,
      });
      // Existing engineer design + investigator review + deterministic admission + freezeSuite gates all run.
      if (outcome.status !== 'completed') return { status: 'pending' };
      return { status: 'complete', suite: verifyAdmittedFrozenSuite(outcome.suite) };
    },
  });
}

/** Authenticated human intake only. No provider/generation/workflow invocation. */
async function humanDataReviewInTransaction(sql: AgentTransactionalSql, jobId: string, digest: string, submission?: { receiptId: string; decision: 'approved' | 'rejected'; reviewed: DataBatch }) {
  const human = await getCurrentCustomer();
  if (!human?.isOperator || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('data_review_unavailable');
  const s = await scoped(jobId, sql);
  const request = await s.operations.get(`data-review-request:${digest}`);
  if (request?.state !== 'complete') throw new Error('data_review_unavailable');
  const snapshot = structuredClone(request.result) as { task: DataTaskSpec; candidates: DataBatch };
  if (snapshot.task.jobId !== jobId) throw new Error('data_review_scope');
  if (!submission) return snapshot;
  submission = structuredClone(submission);
  if (!['approved', 'rejected'].includes(submission.decision)) throw new Error('data_review_invalid');
  // Principal IDs come from the authenticated session; the human still explicitly supplies every permission/evidence determination.
  const reviewed = submission.reviewed;
  reviewed.sources = reviewed.sources.map(source => ({ ...source, review: { ...source.review, reviewerId: human.id } }));
  reviewed.cases = reviewed.cases.map(c => c.verification ? { ...c, verification: { ...c.verification, verifierId: human.id } } : c);
  await s.reviews.submit({ receiptId: submission.receiptId, decision: submission.decision, task: snapshot.task, candidates: snapshot.candidates, reviewed });
  const bound = (await sql.query<{workflow_run_id:string}>(`SELECT workflow_run_id FROM jobs WHERE id=$1 AND customer_id=$2 AND environment=$3 AND package='text_eval' AND is_mock=false AND state IN ('planning','running','investigating') FOR UPDATE`, [jobId,s.job.customerId,s.job.environment])).rows[0];
  if(!bound?.workflow_run_id) throw new Error('data_review_scope');
  await enqueueReviewResume(sql,{jobId,tenantId:s.job.customerId,environment:s.job.environment,workflowRunId:bound.workflow_run_id},digest);
  return { status: 'recorded' as const };
}

/** One READ COMMITTED pinned transaction, no callback retries: receipt + canonical review + wake intent.
 * Flatten ONLY ledger-local transactions onto this pinned outer transaction; errors propagate and roll back all writes. */
export async function humanDataReview(jobId: string, digest: string, submission?: { receiptId: string; decision: 'approved'|'rejected'; reviewed: DataBatch }) {
 return database().transaction(async tx => {
  const pinned: AgentTransactionalSql = {query: (q,p) => tx.query(q,p),transaction: fn => fn(tx)};
  return humanDataReviewInTransaction(pinned,jobId,digest,submission);
 });
}
