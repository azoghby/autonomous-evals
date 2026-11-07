import "server-only";
import { GENERIC_JOB_ERROR } from "./public-error";
import { createRealtime, rawSql, type SealedLiveQuery } from "@neon/realtime/server";

/**
 * Neon Realtime (beta) server side. The secret never leaves this module; the browser only ever gets
 * the Live SQL URL and sealed queries (encrypted, signed, short-lived capabilities for ONE fixed query).
 * Every query below is a fixed SQL template; the only parameter is a validated job id that the route
 * has already authorized for the viewer.
 */
let server: ReturnType<typeof create> | undefined;
function create() {
  const secret = process.env.NEON_REALTIME_SECRET;
  if (!secret) throw new Error("NEON_REALTIME_SECRET is not set");
  return createRealtime({ secret, db: process.env.NEON_REALTIME_DB || "app" });
}
const realtime = () => (server ??= create());

export const realtimeUrl = () => process.env.NEON_REALTIME_URL ?? null;
export const realtimeConfigured = () => !!process.env.NEON_REALTIME_URL && !!process.env.NEON_REALTIME_SECRET;

export interface LiveProgressRow { id: string; milestone: string; message: string; created_at: Date }
export interface LiveJobRow { id: string; state: string; error: string | null; updated_at: Date }

/** Sealed queries for ONE job. Caller MUST have passed canViewJob() for this viewer + job. */
export async function sealJobLive(jobId: string, isOperator = false) {
  const [progress, job] = await Promise.all([
    realtime().seal({
      query: rawSql<LiveProgressRow>(
        `SELECT id, milestone, message, created_at FROM progress_events WHERE job_id = $1 ORDER BY created_at ASC, id ASC`,
        [jobId],
      ),
    }),
    realtime().seal({
      // Customers never receive the raw jobs.error; operators do.
      query: isOperator
        ? rawSql<LiveJobRow>(`SELECT id, state, error, updated_at FROM jobs WHERE id = $1`, [jobId])
        : rawSql<LiveJobRow>(
          `SELECT id, state, CASE WHEN error IS NULL OR error = '' THEN NULL ELSE $2::text END AS error, updated_at FROM jobs WHERE id = $1`,
          [jobId, GENERIC_JOB_ERROR],
        ),
    }),
  ]);
  return { progress, job };
}

export interface LiveOpJob { id: string; package: string; state: string; environment: string; is_mock: boolean; created_at: Date; updated_at: Date }
export interface LiveOpPayment { id: string; job_id: string; amount_cents: number; environment: string; kind: string; created_at: Date }
export interface LiveOpIntervention { id: string; job_id: string | null; operator_email: string; kind: string; note: string; created_at: Date }

/** Operator-only overview essentials. Caller MUST have checked viewer.isOperator. */
export async function sealOperatorLive() {
  const q = <R>(sql: string) => realtime().seal({ query: rawSql<R>(sql) });
  const [jobs, payments, interventions] = await Promise.all([
    q<LiveOpJob>(`SELECT id, package, state, environment, is_mock, created_at, updated_at FROM jobs ORDER BY created_at DESC, id DESC LIMIT 200`),
    q<LiveOpPayment>(`SELECT id, job_id, amount_cents, environment, kind, created_at FROM payments ORDER BY created_at DESC, id DESC LIMIT 200`),
    q<LiveOpIntervention>(`SELECT id, job_id, operator_email, kind, note, created_at FROM interventions ORDER BY created_at DESC, id DESC LIMIT 200`),
  ]);
  return { jobs, payments, interventions };
}

export type { SealedLiveQuery };
