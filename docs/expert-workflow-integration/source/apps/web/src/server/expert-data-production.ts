import { isOperator } from '@ae/core/auth/tokens';
import 'server-only';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { createHash } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { pooledCalendarDatabase } from '@ae/core/simulator/pool';
import { buildAgentDeps } from '@ae/core/integration/eval-services';
import { decryptJson } from '@ae/core/storage/crypto';
import { createPostgresEvaluationDataStore } from '@ae/core/evals/data/postgres-store';
import { createPostgresDataOperationLedger } from '@ae/core/evals/data/postgres-operations';
import { createAuthenticatedDataReviewLedger } from '@ae/core/evals/data/review-ledger';
import { advanceDataOrchestration, createDataCostCapture, type DataOrchestrationPorts } from '@ae/core/evals/data/orchestration';
import { createNaiveGenerationAdapter } from '@ae/core/evals/data/adapters/generation';
import { PostgresBudgetLedger } from '@ae/core/agents/postgres-ports';
import { createOwnerExpertStep } from './automated-expert-owner';
import { createSqlExpertResponseService } from './automated-expert-responses';
import { expertContributionContextDigest, reviewExpertContribution, type ExpertContributionReview } from '@ae/core/evals/data/expert';
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
import { recordCost, jobKnownCostMicroUsd } from './job-store';
import { JOB_BUDGET_MICRO_USD } from '@ae/core/contracts/index';

let pool: Pool | undefined;
function database() {
  const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
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
  async function assertCurrent(value?: unknown) {
    if(process.env.EVAL_SERVICES !== 'real') throw new Error('expert_real_mode_not_active');
    const current = await sql.query(`SELECT 1 FROM jobs j JOIN expert_workflow.plans p ON p.job_id=j.id
      WHERE j.id=$1 AND j.customer_id=$2 AND j.environment=$3 AND j.package='text_eval' AND NOT j.is_mock
      AND j.state IN ('planning','running','investigating') AND p.enabled AND p.tenant_id=j.customer_id
      AND p.response_deadline>now()`, [jobId,row.customer_id,row.environment]);
    if (current.rows.length !== 1) throw new Error('expert_plan_revoked');
    const credentials = await sql.query<{ciphertext:string}>('SELECT ciphertext FROM job_credentials WHERE job_id=$1',[jobId]);
    const values = credentials.rows[0] ? decryptJson<Record<string,string>>(credentials.rows[0].ciphertext) : {};
    const fresh = [...Object.values(values),...Object.entries(process.env).filter(([k])=>/(?:KEY|TOKEN|SECRET|DATABASE_URL)$/.test(k)).map(([,v])=>v??'')].filter(Boolean);
    if (fresh.some(v=>typeof v!=='string')) throw new Error('data_credentials_invalid');
    secrets.splice(0,secrets.length,...fresh);
    if (value !== undefined && !inspectDataSafety(value,secrets).safe) throw new Error('unsafe_current_data');
    return secrets;
  }
  await assertCurrent();
  const ownerId = 'data_service_v1';
  const operations = createPostgresDataOperationLedger(sql, {
    tenantId: row.customer_id, jobId, ownerId, knownSecrets: secrets,
    authenticateOwner: async () => {
      await assertCurrent();
      return { ownerId };
    },
    // No reconciliation endpoint: a different owner cannot complete or take over an ambiguous effect.
  });
  const job: JobRef = { jobId, customerId: row.customer_id, package: 'text_eval', environment: row.environment,
    quoteVersion: null, linkedRetestOf: row.retest_of_job_id, isFixture: false };
  async function durable(key: string, value: unknown) {
    await assertCurrent(value);
    const digest = reviewDigest(value);
    await operations.claim(key, digest);
    await operations.complete(key, digest, value);
  }
  async function deliverCost(cost: CostEntry) {
    await assertCurrent(cost);
    cost = CostEntrySchema.parse(cost);
    if (cost.jobId !== jobId || !cost.measured || !cost.externalId || !inspectDataSafety(cost, secrets).safe) throw new Error('data_cost_invalid');
    const entry = toContractCost(cost);
    // Single global keyed sink shared with rich sessions; conflicts fail closed.
    await recordCost({ ...entry, jobId });
  }
  const reviews = createAuthenticatedDataReviewLedger({ operations, knownSecrets: secrets, authenticateHuman: async task => {
    const human = await getCurrentCustomer();
    // Existing operator allowlist + real session; read-only job share/customer access does not grant review authority.
    if (!human?.isOperator || task.jobId !== jobId) return null;
    return { principalId: human.id };
  } });
  async function drainDesignCosts() {
    const keys = await sql.query<{ operation_key: string }>(
      "SELECT operation_key FROM evaluation_data_persistence.operations WHERE tenant_id=$1 AND job_id=$2 AND (operation_key LIKE 'data-design-cost:%' OR operation_key LIKE 'expert-extraction-cost:%') ORDER BY operation_key LIMIT 1001", [row.customer_id, jobId]);
    if (keys.rows.length > 1000) throw new Error('data_cost_inventory_too_large');
    for (const { operation_key } of keys.rows) {
      const record = await operations.get(operation_key); // Includes current-secret and checksum validation.
      if (record?.state !== 'complete') throw new Error('data_cost_pending');
      await deliverCost(record.result as CostEntry);
    }
  }
  return { sql, operations, job, secrets, assertCurrent, durable, deliverCost, reviews, drainDesignCosts };
}

export interface ProductionDataInput {
  task: DataTaskSpec;
  initial: DataBatch;
  context: Pick<DataDesignContext, 'versionLabel' | 'systemPrompt'>;
  /** Trusted operator configuration. Undefined means no discovery, not permission to search arbitrary URLs. */
  discovery?: { providerOrigin: string; queries: string[] };
}

/** Exact producer seam for the owning Workflow step. Input comes from its authorized durable job plan, never HTTP. */
export async function advanceExpertProductionData(jobId: string, input: ProductionDataInput, topic: string) {
  if (process.env.EVAL_SERVICES !== 'real') throw new Error('expert_real_mode_not_active');
  input = structuredClone(input);
  const s = await scoped(jobId);
  if (input.task.jobId !== jobId) throw new Error('data_scope_mismatch');
  await s.durable(`data-production-input:${input.task.taskId}`, input);
  await s.drainDesignCosts(); // Retry a lost cost acknowledgement even when freeze itself stays fenced.
  const { runner: rawRunner } = await buildAgentDeps();
  const cap = JOB_BUDGET_MICRO_USD.text_eval;
  const runner: typeof rawRunner = { run: async spec => {
    await s.assertCurrent();
    const spent = await jobKnownCostMicroUsd(jobId);
    if (!Number.isSafeInteger(spent) || spent < 0 || spent >= cap || spec.budgetMicroUsd > cap-spent) throw new Error('data_budget_pending');
    const result = await rawRunner.run(spec);
    await s.assertCurrent(result);
    return result;
  } };
  const generate = createNaiveGenerationAdapter({ runner, job: s.job, sessionCapMicroUsd: 250_000, jobCapMicroUsd: cap,
    knownSecrets: s.secrets, onMeasuredCost: createDataCostCapture(s.operations, s.secrets) });
  const rawDiscover = input.discovery ? createMediaWikiDiscovery({ ...input.discovery, knownSecrets: s.secrets,
    operations: createPostgresDiscoveryOperations({ db: s.sql, authenticatedScope: { tenantId: s.job.customerId, jobId }, knownSecrets: s.secrets }) }).discover
    : async () => ({ status: 'complete' as const, data: { sources: [], cases: [] } });
  const discover: typeof rawDiscover = async request => {
    await s.assertCurrent(request);
    const result = await rawDiscover(request);
    await s.assertCurrent(result);
    return result;
  };
  const expert = async (request: import('@ae/core/evals/data/acquisition').AcquisitionRequest) => {
    await s.assertCurrent(request);
    const scope = { jobId, taskId: input.task.taskId, operationId: `expert:${reviewDigest(request.operationKey)}`,
      requestHash: reviewDigest({ task: input.task, topic }) };
    const responses = createSqlExpertResponseService(s.sql, { scope, tenantId: s.job.customerId, topic,
      runner, job: s.job, sessionCapMicroUsd: 250_000, jobCapMicroUsd: cap,
      knownSecrets: () => s.secrets, onMeasuredCost: async entry => {
        await s.durable(`expert-extraction-cost:${identity(entry.taskKey)}`, entry.cost);
        await s.deliverCost(entry.cost);
      } });
    const adapter = createOwnerExpertStep(s.sql, { scope, tenantId: s.job.customerId, topic,
      appUrl: process.env.APP_URL ?? '', companyAddress: process.env.COMPANY_ADDRESS ?? '', knownSecrets: async () => s.assertCurrent(),
      ledger: tx => new PostgresBudgetLedger({ query: tx.query.bind(tx), transaction: fn => fn(tx) }),
      contributions: async (_scope, deliveryId) => {
        const result = await responses.extract(input.task, deliveryId);
        if (result.status !== 'candidate') return [];
        const contribution = result.contribution;
        const digest = expertContributionContextDigest(input.task, contribution);
        // Candidate publication grants no factual authority. A human must review the exact snapshot.
        await s.durable(`expert-review-candidate:${digest}`, { task: input.task, contribution });
        const row = (await s.sql.query<{ review: ExpertContributionReview; reviewer_email: string; reviewer_id: string }>(
          `SELECT r.review,c.email AS reviewer_email,r.reviewer_id::text FROM expert_workflow.contribution_reviews r JOIN customers c ON c.id=r.reviewer_id
           WHERE r.job_id=$1 AND r.task_id=$2 AND r.contribution_digest=$3`, [jobId,input.task.taskId,digest])).rows[0];
        if (!row || !isOperator(row.reviewer_email) || row.review.reviewerId !== row.reviewer_id
          || row.review.contextDigest !== digest || !reviewExpertContribution(input.task,contribution,row.review,s.secrets).accepted) return [];
        return [{ contribution, review: row.review }];
      } });
    const result = await adapter(request);
    await s.assertCurrent(result);
    return result;
  };
  const freeze: DataOrchestrationPorts['freeze'] = async ({ mapping }) => {
      await s.assertCurrent(mapping);
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
      await s.assertCurrent(outcome);
      if (outcome.status !== 'completed') return { status: 'pending' };
      return { status: 'complete', suite: verifyAdmittedFrozenSuite(outcome.suite) };
  };
  const result = await advanceDataOrchestration(input.task, input.initial, { ...input.context, job: s.job, knownSecrets: s.secrets }, {
    operations: s.operations, knownSecrets: s.secrets, resumeExpert: expert, resumeGeneration: generate,
    acquisition: { store: createPostgresEvaluationDataStore(s.sql, { tenantId: s.job.customerId, jobId, knownSecrets: s.secrets }), discover, generate, expert },
    readReview: async request => {
      // Acquisition may not save merged candidates until review succeeds; publish the exact private immutable snapshot here.
      await s.durable(`data-review-request:${request.digest}`, { task: request.task, candidates: request.data });
      return s.reviews.readReview(request);
    },
    deliverCost: entry => s.deliverCost(entry.cost),
    freeze, resumeFreeze: freeze,
  });
  await s.assertCurrent(result);
  return result;
}

/** Existing authenticated operator session is required. Candidates and exact source/answer judgments
 * remain private; submitting this review never runs a provider or sends an invitation. */
export async function reviewExpertWorkflowData(jobId: string, digest: string, submission?: {
  receiptId: string; decision: 'approved' | 'rejected'; reviewed: DataBatch;
}) {
  const human = await getCurrentCustomer();
  if (!human?.isOperator || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('data_review_unavailable');
  const s = await scoped(jobId);
  const request = await s.operations.get(`data-review-request:${digest}`);
  if (request?.state !== 'complete') throw new Error('data_review_unavailable');
  const snapshot = request.result as { task: DataTaskSpec; candidates: DataBatch };
  if (snapshot.task.jobId !== jobId) throw new Error('data_review_scope');
  if (!submission) return structuredClone(snapshot);
  const reviewed = structuredClone(submission.reviewed);
  reviewed.sources = reviewed.sources.map(source => ({ ...source, review: { ...source.review, reviewerId: human.id } }));
  reviewed.cases = reviewed.cases.map(c => c.verification ? { ...c, verification: { ...c.verification, verifierId: human.id } } : c);
  await s.assertCurrent(reviewed);
  await s.reviews.submit({ ...submission, task: snapshot.task, candidates: snapshot.candidates, reviewed });
  return { status: 'recorded' as const };
}

/** Authenticated exact-snapshot contribution review. Receipt identity is server derived. */
export async function reviewExpertWorkflowContribution(jobId: string, digest: string, review: ExpertContributionReview) {
  const human = await getCurrentCustomer();
  if (!human?.isOperator || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('expert_review_unavailable');
  const s = await scoped(jobId);
  const record = await s.operations.get(`expert-review-candidate:${digest}`);
  if (record?.state !== 'complete') throw new Error('expert_review_unavailable');
  const snapshot = record.result as { task: DataTaskSpec; contribution: import('@ae/core/evals/data/expert').ExpertContribution };
  review = { ...structuredClone(review), reviewerId: human.id, contextDigest: digest };
  if (snapshot.task.jobId !== jobId || expertContributionContextDigest(snapshot.task,snapshot.contribution) !== digest
    || !reviewExpertContribution(snapshot.task,snapshot.contribution,review,s.secrets).accepted) throw new Error('expert_review_invalid');
  await s.assertCurrent({ snapshot, review });
  const sql = s.sql;
  await sql.query(`INSERT INTO expert_workflow.contribution_reviews(job_id,task_id,contribution_digest,reviewer_id,review)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`, [jobId,snapshot.task.taskId,digest,human.id,JSON.stringify(review)]);
  const retained = (await sql.query<{review:ExpertContributionReview}>(`SELECT review FROM expert_workflow.contribution_reviews
    WHERE job_id=$1 AND task_id=$2 AND contribution_digest=$3`,[jobId,snapshot.task.taskId,digest])).rows[0];
  if (!retained || reviewDigest(retained.review) !== reviewDigest(review)) throw new Error('expert_review_conflict');
  return { status: 'recorded' as const };
}
