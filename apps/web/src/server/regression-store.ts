import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@ae/core/db/client";
import type { RegressionVerdict } from "./regression-check";

export type RegressionRunStatus = "running" | "completed" | "failed";
export interface RegressionRunRecord {
  runId: string;
  jobId: string;
  customerId: string;
  status: RegressionRunStatus;
  createdAt: string;
  result?: RegressionVerdict;
  error?: string;
}

export interface RegressionRunStore {
  save(rec: RegressionRunRecord): Promise<void>;
  get(runId: string): Promise<RegressionRunRecord | null>;
}

/**
 * Backed by the `regression_runs` table (see report for the Drizzle/SQL). Until that migration is applied
 * it falls back to a per-process map, which is enough for synchronous runs and single-instance dev.
 */
const memory = new Map<string, RegressionRunRecord>();
const MEMORY_MAX = 500;

function remember(rec: RegressionRunRecord) {
  memory.set(rec.runId, rec);
  if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value as string);
}

export const sqlRegressionStore: RegressionRunStore = {
  async save(rec) {
    remember(rec);
    try {
      await db().execute(sql`
        INSERT INTO regression_runs (id, job_id, customer_id, status, result, error, created_at)
        VALUES (${rec.runId}, ${rec.jobId}, ${rec.customerId}, ${rec.status}, ${rec.result ? JSON.stringify(rec.result) : null}::jsonb, ${rec.error ?? null}, ${rec.createdAt})
        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, result = EXCLUDED.result, error = EXCLUDED.error
      `);
    } catch (err) {
      console.error("regression_runs table unavailable, using in-memory store", err instanceof Error ? err.message : err);
    }
  },
  async get(runId) {
    try {
      const res = await db().execute(sql`SELECT id, job_id, customer_id, status, result, error, created_at FROM regression_runs WHERE id = ${runId} LIMIT 1`);
      const row = res.rows[0] as Record<string, unknown> | undefined;
      if (row) {
        return {
          runId: String(row.id), jobId: String(row.job_id), customerId: String(row.customer_id),
          status: row.status as RegressionRunStatus, createdAt: new Date(row.created_at as string).toISOString(),
          ...(row.result ? { result: row.result as RegressionVerdict } : {}), ...(row.error ? { error: String(row.error) } : {}),
        };
      }
    } catch { /* table missing: fall through to memory */ }
    return memory.get(runId) ?? null;
  },
};
