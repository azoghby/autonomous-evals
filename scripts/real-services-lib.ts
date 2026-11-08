/**
 * Shared helpers for operator scripts that exercise EVAL_SERVICES=real (Track B on Naïve) outside a Workflow.
 * Loads app modules lazily so the SDK (ESM-only) goes through the ESM loader.
 */
import type { EvalServices } from "../packages/core/src/contracts/services";

export const FIXTURE_CUSTOMER_EMAIL = "sandbox-e2e@example.com";

/**
 * Idempotent: internal-fixture customer + draft test job (never revenue, never emailed).
 * Real Track B resolves ctx.jobId against `jobs`, and keys durable agent tasks by job + role + purpose.
 */
export async function ensureFixtureJob(jobId: string): Promise<string> {
  const { db, schema } = await import("../packages/core/src/db/client");
  const { sql } = await import("drizzle-orm");
  const d = db();
  await d.insert(schema.customers).values({ email: FIXTURE_CUSTOMER_EMAIL, name: "Sandbox E2E", source: "walk_up", isInternalFixture: true }).onConflictDoNothing();
  const [owner] = await d.select({ id: schema.customers.id, fixture: schema.customers.isInternalFixture }).from(schema.customers)
    .where(sql`lower(${schema.customers.email}) = ${FIXTURE_CUSTOMER_EMAIL}`).limit(1);
  if (!owner?.fixture) throw new Error(`${FIXTURE_CUSTOMER_EMAIL} is missing or not an internal fixture; refusing to seed`);
  await d.insert(schema.jobs).values({
    id: jobId, customerId: owner.id, package: "trace_audit", state: "draft", environment: "test",
    intake: { package: "trace_audit", conformance: true },
  }).onConflictDoNothing();
  const [job] = await d.select({ customerId: schema.jobs.customerId, environment: schema.jobs.environment }).from(schema.jobs)
    .where(sql`${schema.jobs.id} = ${jobId}`).limit(1);
  if (job?.customerId !== owner.id || job.environment !== "test") throw new Error("fixture job id is taken by a non-fixture job; refusing");
  return jobId;
}

const PENDING = /^(TrackBPendingError|BranchCleanupPendingError)$/;
const MAX_PENDING_RETRIES = 12;
const MIN_RETRY_DELAY_MS = 3_000;
const MAX_RETRY_DELAY_MS = 20_000;

/**
 * Real services surface "try later" as typed errors that the Workflow turns into RetryableError
 * (Naïve rate limits, in-flight sessions, async Neon branch deletion) or flag `retryable: true`
 * (e.g. NeonConnectionError branch_not_ready while a new endpoint starts). Emulate that retry here;
 * the durable task key makes each retry resume the same session rather than start a new one.
 */
export function withPendingRetry(services: EvalServices): EvalServices {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(services)) {
    if (typeof fn !== "function") continue;
    out[name] = async (...args: unknown[]) => {
      for (let attempt = 0; ; attempt++) {
        try { return await (fn as (...a: unknown[]) => unknown).apply(services, args); }
        catch (e) {
          const err = e as { name?: string; retryAfterMs?: number; retryable?: unknown };
          const pending = PENDING.test(err.name ?? "") || err.retryable === true;
          if (!pending || attempt >= MAX_PENDING_RETRIES) throw e;
          const delay = Math.min(Math.max(err.retryAfterMs ?? 0, MIN_RETRY_DELAY_MS), MAX_RETRY_DELAY_MS);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    };
  }
  return out as unknown as EvalServices;
}
