import { randomUUID } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import type { BudgetReserver, ReserveResult } from "../contracts/services";
import {
  lockJobBudget, jobBudgetExposure, reserveJobBudget, reserveWorkflowJobBudget,
  markJobBudgetDispatched, releaseWorkflowJobBudget, type JobBudgetTx,
} from "../db/job-budget-authority";

let pool: Pool | undefined;

/** Pinned READ COMMITTED transaction: no HTTP batches, automatic retries, or callback replay. */
async function transaction<T>(fn: (tx: JobBudgetTx) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  pool ??= new Pool({ connectionString, max: 5 });
  const connection = await pool.connect();
  let discard: Error | undefined;
  try {
    await connection.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const tx: JobBudgetTx = {
      async query<R>(text: string, params?: unknown[]) {
        const result = await connection.query(text, params);
        return { rows: result.rows as R[] };
      },
    };
    const result = await fn(tx);
    try { await connection.query("COMMIT"); }
    catch (error) { discard = new Error("budget_commit_uncertain"); throw error; }
    return result;
  } catch (error) {
    try { await connection.query("ROLLBACK"); }
    catch { discard = new Error("budget_rollback_failed"); }
    throw error;
  } finally { connection.release(discard); }
}

export type WorkflowAdmission =
  | { ok: true; reservationId: string; amountMicroUsd: number }
  | { ok: false; remainingMicroUsd: number };

/** Reuse an open stage on retry; a subsequent successful same-agent stage gets a new hold. */
export async function reserveWorkflowBudget(jobId: string, agent: string, share: number): Promise<WorkflowAdmission> {
  if (!Number.isFinite(share) || share <= 0 || share > 1) throw new Error("invalid budget share");
  return transaction(async tx => {
    await lockJobBudget(tx, jobId);
    const exposure = await jobBudgetExposure(tx, jobId);
    const amountMicroUsd = Math.floor(exposure.capMicroUsd * share);
    const result = await reserveWorkflowJobBudget(tx, { jobId, agent, amountMicroUsd });
    return result.ok
      ? { ok: true, reservationId: result.reservationId, amountMicroUsd }
      : { ok: false, remainingMicroUsd: result.remainingMicroUsd };
  });
}

export async function releaseWorkflowBudget(jobId: string, reservationId: string): Promise<void> {
  await transaction(tx => releaseWorkflowJobBudget(tx, jobId, reservationId));
}

export function createBudgetReserver(jobId: string): BudgetReserver {
  return {
    async reserve(agent, microUsd): Promise<ReserveResult> {
      if (!Number.isSafeInteger(microUsd) || microUsd <= 0) throw new Error("microUsd must be a positive integer");
      // This legacy API has no caller idempotency key. An unknown commit remains held;
      // callers must never assume a failed reserve means no reservation exists.
      const operationId = `adapter:${randomUUID()}`;
      return transaction(async tx => {
        const result = await reserveJobBudget(tx, { jobId, operationId, amountMicroUsd: microUsd, workflowAgent: agent });
        if (!result.ok) return { ok: false, remainingMicroUsd: result.remainingMicroUsd };
        await markJobBudgetDispatched(tx, jobId, operationId);
        return { ok: true, reservationId: result.reservationId };
      });
    },
    release: reservationId => releaseWorkflowBudget(jobId, reservationId),
  };
}
