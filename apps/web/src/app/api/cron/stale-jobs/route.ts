import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { requireCronAuth } from "../_auth";

export const dynamic = "force-dynamic";

const STALE_MS = 30 * 60_000;
const FLAG = "stale_flagged";
const AUTH_FLAG = "authorization_expiring";
const AUTH_WARN_MS = 5 * 86_400_000; // Stripe card authorizations expire after ~7 days

/** Flags (never restarts) running jobs with no progress for 30 minutes: a progress note plus an operator-visible intervention row. */
export async function GET(request: Request) {
  const denied = requireCronAuth(request);
  if (denied) return denied;
  const now = Date.now();
  const active = await db().select({ id: schema.jobs.id, updatedAt: schema.jobs.updatedAt }).from(schema.jobs)
    .where(inArray(schema.jobs.state, ["planning", "running", "investigating"]));
  const flagged: string[] = [];
  for (const job of active) {
    const [real] = await db().select({ at: schema.progressEvents.createdAt }).from(schema.progressEvents)
      .where(and(eq(schema.progressEvents.jobId, job.id), ne(schema.progressEvents.milestone, FLAG)))
      .orderBy(desc(schema.progressEvents.createdAt)).limit(1);
    const lastProgress = Math.max(real?.at.getTime() ?? 0, job.updatedAt.getTime());
    if (now - lastProgress < STALE_MS) continue;
    const [prior] = await db().select({ at: schema.progressEvents.createdAt }).from(schema.progressEvents)
      .where(and(eq(schema.progressEvents.jobId, job.id), eq(schema.progressEvents.milestone, FLAG)))
      .orderBy(desc(schema.progressEvents.createdAt)).limit(1);
    if (prior && prior.at.getTime() > lastProgress) continue; // already flagged since the last real progress
    const minutes = Math.round((now - lastProgress) / 60_000);
    await db().insert(schema.progressEvents).values({
      jobId: job.id, milestone: FLAG, message: `No progress for ${minutes} minutes. Flagged for operator review.`,
    });
    await db().insert(schema.interventions).values({
      jobId: job.id, operatorEmail: "system@cron", kind: "other", note: `Stale job: no progress for ${minutes} minutes. Not restarted automatically.`,
    });
    flagged.push(job.id);
  }
  const expiring = await flagExpiringAuthorizations(now);
  return Response.json({ checked: active.length, flagged, expiringAuthorizations: expiring });
}

/** Per-finding holds still uncaptured after 5 days are about to lapse: flag once per payment for an operator. */
async function flagExpiringAuthorizations(now: number): Promise<string[]> {
  const held = await db().select({ id: schema.payments.id, jobId: schema.payments.jobId, createdAt: schema.payments.createdAt })
    .from(schema.payments).where(eq(schema.payments.status, "authorized"));
  const flagged: string[] = [];
  for (const p of held) {
    if (now - p.createdAt.getTime() < AUTH_WARN_MS) continue;
    const [prior] = await db().select({ id: schema.progressEvents.id }).from(schema.progressEvents)
      .where(and(eq(schema.progressEvents.jobId, p.jobId), eq(schema.progressEvents.milestone, AUTH_FLAG))).limit(1);
    if (prior) continue;
    await db().insert(schema.progressEvents).values({
      jobId: p.jobId, milestone: AUTH_FLAG, message: "Internal note: payment authorization is over 5 days old and may expire soon. Operator review needed.",
    });
    await db().insert(schema.interventions).values({
      jobId: p.jobId, operatorEmail: "system@cron", kind: "other",
      note: "Per-finding authorization held over 5 days (Stripe holds expire after ~7 days). Capture or release it now.",
    });
    flagged.push(p.jobId);
  }
  return flagged;
}
