import "server-only";
import { z } from "zod";
import { createDurableProgressProjection, createDurableProgressReader, type ProjectionPlan } from "@ae/core/reporting/chat/projection/index";
import { ChatError, type ChatScope, type ProgressSnapshot, type ConversationSqlExecutor } from "@ae/core/reporting/chat/index";
import { PostgresTextCheckpointStore } from "@ae/core/evals/integration/checkpoints";
import { createPostgresEvaluationDataStore } from "@ae/core/evals/data/postgres-store";

const invalid = (): never => { throw new ChatError("invalid_snapshot"); };
const id = z.string().min(1).max(4096);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const inventoryPlanSchema = z.strictObject({
  checkpoints: z.array(z.strictObject({
    key: z.strictObject({ jobId: id, kind: id, id, inputDigest: digest }),
    phase: z.enum(["planning", "running", "investigating"]),
    format: z.enum(["text_design", "text_run", "calendar_run", "text_investigation", "calendar_investigation"]),
    runId: id.optional(), suiteDigest: id.optional(), branchId: id.optional(), scenarioIds: z.array(id).min(1).max(200).optional(),
  })).max(100),
  acquisitionTaskIds: z.array(id).max(100),
}).refine(plan => (plan.checkpoints.length > 0 || plan.acquisitionTaskIds.length > 0)
  && plan.checkpoints.every(p => p.phase === (p.format === "text_design" ? "planning" : p.format.endsWith("_run") ? "running" : "investigating")));
export type InventoryPlan = z.infer<typeof inventoryPlanSchema>;
type Job = { id: string; customer_id: string; state: string; updated_at: Date | string };
type Inventory = { tenant_id: string; job_id: string; environment: "test" | "live"; revision: string | number;
  plan: unknown; observed_at: Date | string };
const iso = (value: Date | string) => new Date(value).toISOString();

/** Called ONLY inside the request's authorized pinned REPEATABLE READ read-only transaction.
 * The caller already obtained job and current secrets in that same transaction. No writes,
 * retries, provider calls or arbitrary checkpoint discovery are possible here. */
export async function readStructuredProgress(tx: ConversationSqlExecutor, scope: ChatScope, job: Job,
  key: Buffer, knownSecrets: string[], appObservedAt = iso(job.updated_at)): Promise<ProgressSnapshot | null> {
  const jobs = await tx.query<{ package: string; environment: string }>(
    "SELECT package, environment FROM jobs WHERE id = $1 AND customer_id = $2", [job.id, job.customer_id]);
  const current = jobs.rows[0];
  if (!current || scope.jobId !== job.id) invalid();
  if (current.package === "trace_audit") return null;
  if (!["text_eval", "workflow_eval", "version_comparison"].includes(current.package)) invalid();
  const load = async () => (await tx.query<Inventory>(
    "SELECT tenant_id, job_id, environment, revision, plan, observed_at FROM structured_progress.inventory WHERE tenant_id = $1 AND job_id = $2",
    [job.customer_id, job.id])).rows[0];
  const inventory = await load();
  if (!inventory || inventory.tenant_id !== job.customer_id || inventory.job_id !== job.id || inventory.environment !== current.environment
    || !/^(0|[1-9][0-9]*)$/.test(String(inventory.revision)) || !Number.isSafeInteger(Number(inventory.revision))) invalid();
  const parsed = inventoryPlanSchema.safeParse(inventory.plan);
  const parsedPlan = parsed.success ? parsed.data : invalid();
  const plan: ProjectionPlan = { ...parsedPlan, scope, environment: inventory.environment };
  if (plan.checkpoints.some(p => p.key.jobId !== job.id || (current.package === "workflow_eval" ? !p.format.startsWith("calendar_") : p.format.startsWith("calendar_")))) invalid();
  const access = { authenticate: async () => ({ subjectId: scope.subjectId }),
    resolveAuthorizedJob: async (caller: { subjectId: string }, jobId: string) =>
      caller.subjectId === scope.subjectId && jobId === job.id ? scope : null };
  const readOnlyDb = { query: tx.query.bind(tx), transaction: async <T>(_run: unknown): Promise<T> => invalid() };
  const checkpoints = new PostgresTextCheckpointStore(readOnlyDb);
  const acquisition = createPostgresEvaluationDataStore(readOnlyDb, { tenantId: job.customer_id, jobId: job.id, knownSecrets });
  const reader = createDurableProgressReader({ withRead: async (requested, read) => {
    const recheck = await load();
    if (!recheck || JSON.stringify(requested) !== JSON.stringify(plan) || String(recheck.revision) !== String(inventory.revision)
      || JSON.stringify(recheck.plan) !== JSON.stringify(inventory.plan) || iso(recheck.observed_at) !== iso(inventory.observed_at)) invalid();
    // All dates come from stored material, never request time. Acquisition-only revisions
    // must touch the inventory watermark in the producer transaction (see prerequisites).
    const observedAt = iso(inventory.observed_at);
    if (Date.parse(iso(job.updated_at)) > Date.parse(observedAt) || Date.parse(iso(appObservedAt)) > Date.parse(observedAt)) invalid();
    return read({ observedAt, job: { jobId: job.id, status: job.state as ProgressSnapshot["status"], updatedAt: iso(job.updated_at) },
      // App ledger supports ai_gateway as well as naive. Its complete safe rows are merged
      // by progress-chat.ts below; never mislabel them as measured core naive_session costs.
      costs: [], unknownCosts: true, checkpoints, acquisition });
  } });
  return createDurableProgressProjection({ access, resolve: async () => plan, reader,
    referenceKey: key.toString("hex"), knownSecrets }).read(scope);
}
