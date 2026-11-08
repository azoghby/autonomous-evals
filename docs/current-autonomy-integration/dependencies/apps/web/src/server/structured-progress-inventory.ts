import "server-only";
import { inventoryPlanSchema, type InventoryPlan } from "./structured-progress";
import { ChatError, type ConversationSqlExecutor } from "@ae/core/reporting/chat/index";

const invalid = (): never => { throw new ChatError("invalid_snapshot"); };
const kinds = { text_design: "design", text_run: "run_result", text_investigation: "investigation",
  calendar_run: "calendar_run", calendar_investigation: "calendar_investigation" } as const;

/** Server Workflow composition helper, NEVER an HTTP handler. Caller supplies the
 * authorized tenant/job/environment and typed associations captured at rich-factory
 * boundary. tx MUST be a pinned write transaction. Call after acknowledged core
 * operations and again after every included job/cost/acquisition update. This does
 * not dispatch any operation and cannot discover phases from arbitrary value JSON.
 * No current Track A Workflow invokes this: see PREREQUISITES.md. */
export async function publishStructuredInventory(tx: ConversationSqlExecutor,
  scope: { tenantId: string; jobId: string; environment: "test" | "live" },
  expectedRevision: number | null, input: InventoryPlan): Promise<number> {
  const plan = inventoryPlanSchema.parse(input);
  const jobs = await tx.query<{ environment: string; package: string }>(
    "SELECT environment, package FROM jobs WHERE id = $1 AND customer_id = $2 FOR UPDATE", [scope.jobId, scope.tenantId]);
  const job = jobs.rows[0];
  if (!job || job.environment !== scope.environment || job.package === "trace_audit") invalid();
  if (!["workflow_eval", "text_eval", "version_comparison"].includes(job.package)) invalid();
  if (new Set(plan.checkpoints.map(p => JSON.stringify([p.key.kind, p.key.id]))).size !== plan.checkpoints.length
    || new Set(plan.acquisitionTaskIds).size !== plan.acquisitionTaskIds.length) invalid();
  for (const p of plan.checkpoints) {
    if (p.key.jobId !== scope.jobId || p.key.kind !== kinds[p.format]
      || (job.package === "workflow_eval" ? !p.format.startsWith("calendar_") : p.format.startsWith("calendar_"))) invalid();
    if (p.format.endsWith("_run") || p.format === "calendar_investigation") {
      if (!p.runId || !p.suiteDigest || !p.scenarioIds?.length || new Set(p.scenarioIds).size !== p.scenarioIds.length) invalid();
    }
    if (p.format.startsWith("calendar_") && !p.branchId) invalid();
    // Planned identities MUST come from exact rich-factory canonical inputs. Missing
    // rows remain planned blockers. Existing rows must bind the identical digest.
    const actual = await tx.query<{ input_digest: string }>(
      "SELECT input_digest FROM text_integration.checkpoints WHERE job_id = $1 AND kind = $2 AND id = $3",
      [scope.jobId, p.key.kind, p.key.id]);
    if (actual.rows.length > 1 || (actual.rows[0] && actual.rows[0].input_digest !== p.key.inputDigest)) invalid();
  }
  for (const taskId of plan.acquisitionTaskIds) {
    const actual = await tx.query<{ task_id: string }>(
      "SELECT task_id FROM evaluation_data_persistence.tasks WHERE tenant_id = $1 AND job_id = $2 AND task_id = $3",
      [scope.tenantId, scope.jobId, taskId]);
    if (actual.rows.length > 1) invalid();
  }
  const existing = (await tx.query<{ tenant_id: string; environment: string; revision: string | number; plan: unknown }>(
    "SELECT tenant_id, environment, revision, plan FROM structured_progress.inventory WHERE job_id = $1 FOR UPDATE", [scope.jobId])).rows[0];
  if (existing) {
    if (existing.tenant_id !== scope.tenantId || existing.environment !== scope.environment
      || expectedRevision === null || !Number.isSafeInteger(expectedRevision) || String(existing.revision) !== String(expectedRevision)) invalid();
    const old = inventoryPlanSchema.parse(existing.plan);
    // Previously frozen associations are immutable. Revision may append newly planned
    // operations/tasks; it cannot silently retarget or remove prior evidence.
    for (const p of old.checkpoints) if (!plan.checkpoints.some(n => JSON.stringify(n) === JSON.stringify(p))) invalid();
    for (const id of old.acquisitionTaskIds) if (!plan.acquisitionTaskIds.includes(id)) invalid();
  } else if (expectedRevision !== null) invalid();
  const next = existing ? Number(existing.revision) + 1 : 0;
  if (!Number.isSafeInteger(next)) invalid();
  await tx.query(`INSERT INTO structured_progress.inventory(tenant_id, job_id, environment, revision, plan, observed_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, clock_timestamp())
    ON CONFLICT (job_id) DO UPDATE SET revision = EXCLUDED.revision, plan = EXCLUDED.plan,
      observed_at = GREATEST(structured_progress.inventory.observed_at, EXCLUDED.observed_at)`,
    [scope.tenantId, scope.jobId, scope.environment, next, JSON.stringify(plan)]);
  return next;
}
