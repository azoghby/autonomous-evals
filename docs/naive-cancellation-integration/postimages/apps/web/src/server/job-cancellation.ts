import { Pool } from "@neondatabase/serverless";
import { isOperator } from "@ae/core/auth/tokens";
import type { JobState } from "@ae/core/contracts/index";
import { decideCancel } from "@/workflows/decisions";

export interface CancellationClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(error?: Error): void;
}
export interface CancellationPool { connect(): Promise<CancellationClient> }
export interface CancellationRequest {
  jobId: string; reason: string; requestedBy: string; asOperator: boolean; eventDelivered: boolean; checkoutDone: boolean;
}
export type CancellationResult =
  | { ok: true; request: CancellationRequest; created: boolean }
  | { ok: false; status: 403 | 404 | 409; error: string; state?: string };

let pool: CancellationPool | undefined;
function defaultPool(): CancellationPool {
  const connectionString = process.env.DATABASE_URL_UNPOOLED?.trim();
  if (!connectionString) throw new Error("DATABASE_URL_UNPOOLED is required for cancellation authority");
  return pool ??= new Pool({ connectionString, max: 5 }) as unknown as CancellationPool;
}
function receipt(row: Record<string, unknown>): CancellationRequest {
  return { jobId: String(row.job_id), reason: String(row.reason), requestedBy: String(row.requested_by),
    asOperator: row.as_operator === true, eventDelivered: row.event_delivered_at != null, checkoutDone: row.checkout_done_at != null };
}

/** viewer.id must come from server session authentication. Role/email are re-read under the jobs lock. */
export async function requestJobCancellation(
  jobId: string, viewer: { id: string; allowOperator?: boolean }, reason?: string, authorityPool?: CancellationPool,
): Promise<CancellationResult> {
  const tx = await (authorityPool ?? defaultPool()).connect();
  let discard: Error | undefined;
  let committing = false;
  const commit = async () => {
    committing = true;
    await tx.query("COMMIT");
    committing = false;
  };
  try {
    await tx.query("BEGIN");
    const job = (await tx.query("SELECT customer_id,state FROM jobs WHERE id=$1 FOR UPDATE", [jobId])).rows[0];
    if (!job) { await commit(); return { ok: false, status: 404, error: "Job not found" }; }
    const customer = (await tx.query("SELECT email FROM customers WHERE id=$1 FOR SHARE", [viewer.id])).rows[0];
    const operator = customer && viewer.allowOperator !== false ? isOperator(String(customer.email)) : false;
    // Check current access before revealing even an existing receipt. Do not trust a stale client role.
    if (!customer || (String(job.customer_id) !== viewer.id && !operator)) {
      await commit(); return { ok: false, status: 404, error: "Job not found" };
    }
    const retained = (await tx.query("SELECT * FROM workflow_stage.cancellations WHERE job_id=$1", [jobId])).rows[0];
    if (retained) { await commit(); return { ok: true, request: receipt(retained), created: false }; }
    const decision = decideCancel({ customerId: String(job.customer_id), state: job.state as JobState }, { id: viewer.id, isOperator: operator });
    if (!decision.allowed) {
      await commit();
      return { ok: false, status: decision.status, error: decision.error, state: String(job.state) };
    }
    const why = reason?.trim() || (decision.asOperator ? "Cancelled by an operator" : "Cancelled by the customer");
    if (why.length > 1_000) throw new Error("Cancellation reason exceeds 1000 characters");
    // This immutable row is both the canonical cancellation fence and retained event/outbox intent.
    const row = (await tx.query(`INSERT INTO workflow_stage.cancellations(job_id,reason,requested_by,as_operator)
      VALUES($1,$2,$3,$4) RETURNING *`, [jobId, why, viewer.id, decision.asOperator])).rows[0]!;
    // Publish the terminal state in the same transaction so existing late-payment handling sees cancellation.
    // Outstanding child holds remain charged/reserved until their own usage proof settles them.
    await tx.query("UPDATE jobs SET state='cancelled',updated_at=now() WHERE id=$1", [jobId]);
    await tx.query("INSERT INTO progress_events(job_id,milestone,message) VALUES($1,'cancelled',$2)",
      [jobId, `Job cancelled: ${why.slice(0, 980)}`]);
    await tx.query("INSERT INTO messages(job_id,role,body) VALUES($1,$2,$3)",
      [jobId, decision.asOperator ? "operator" : "customer", `Cancellation requested: ${why}`]);
    if (decision.asOperator) await tx.query("INSERT INTO interventions(job_id,operator_email,kind,note) VALUES($1,$2,'other',$3)",
      [jobId, String(customer.email), `Cancelled job: ${why}`]);
    await commit();
    return { ok: true, request: receipt(row), created: true };
  } catch (error) {
    if (committing) discard = error instanceof Error ? error : new Error("Cancellation COMMIT outcome uncertain");
    try { await tx.query("ROLLBACK"); }
    catch (rollbackError) {
      discard ??= rollbackError instanceof Error ? rollbackError : new Error("Cancellation ROLLBACK failed");
    }
    throw error;
  } finally { tx.release(discard); }
}

/** Delivery acknowledgement only; never creates intent or changes the retained original reason. */
export async function markJobCancellationDelivered(jobId: string, authorityPool?: CancellationPool): Promise<void> {
  const tx = await (authorityPool ?? defaultPool()).connect();
  try {
    await tx.query("UPDATE workflow_stage.cancellations SET event_delivered_at=COALESCE(event_delivered_at,now()) WHERE job_id=$1", [jobId]);
  } finally { tx.release(); }
}

/** Separate retryable cleanup acknowledgement: no spending or provider call occurs here. */
export async function markJobCancellationCheckoutDone(jobId: string, authorityPool?: CancellationPool): Promise<void> {
  const tx = await (authorityPool ?? defaultPool()).connect();
  try { await tx.query("UPDATE workflow_stage.cancellations SET checkout_done_at=COALESCE(checkout_done_at,now()) WHERE job_id=$1", [jobId]); }
  finally { tx.release(); }
}

export async function listPendingCancellationJobs(limit = 100, authorityPool?: CancellationPool): Promise<string[]> {
  const tx = await (authorityPool ?? defaultPool()).connect();
  try {
    const result = await tx.query("SELECT * FROM workflow_stage.cancellations WHERE event_delivered_at IS NULL OR checkout_done_at IS NULL ORDER BY COALESCE(last_attempt_at,'epoch'::timestamptz),requested_at,job_id LIMIT $1", [Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 100]);
    return result.rows.map(row => String(row.job_id));
  } finally { tx.release(); }
}

/** Internal delivery-worker lookup; caller must authenticate before exposing a receipt to a viewer. */
export async function getJobCancellation(jobId: string, authorityPool?: CancellationPool): Promise<CancellationRequest | null> {
  const tx = await (authorityPool ?? defaultPool()).connect();
  try {
    const row = (await tx.query("SELECT * FROM workflow_stage.cancellations WHERE job_id=$1", [jobId])).rows[0];
    return row ? receipt(row) : null;
  } finally { tx.release(); }
}

/** Rotate failed deliveries behind untouched requests without mutating the retained payload. */
export async function markJobCancellationAttempt(jobId: string, authorityPool?: CancellationPool): Promise<void> {
  const tx = await (authorityPool ?? defaultPool()).connect();
  try { await tx.query("UPDATE workflow_stage.cancellations SET last_attempt_at=now() WHERE job_id=$1", [jobId]); }
  finally { tx.release(); }
}
