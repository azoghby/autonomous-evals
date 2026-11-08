import { and, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { requireCronAuth } from "../_auth";
import { processStaleJobs } from "../../../../server/stale-jobs";
import { loadCandidates, staleJobDeps } from "./recovery";

export const dynamic = "force-dynamic";

const AUTH_FLAG = "authorization_expiring";
const AUTH_WARN_MS = 5 * 86_400_000; // Stripe card authorizations expire after ~7 days

/**
 * Recovers stuck jobs. Working jobs idle >15 min: live run -> re-enqueue (max 3 attempts), dead run -> operator
 * intervention (jobs are not restartable). Paid-but-unresumed awaiting_payment jobs idle >5 min: replay the payment.
 * Bounded batch; every attempt and escalation is a progress event, so ticks are idempotent.
 */
export async function GET(request: Request) {
  const denied = requireCronAuth(request);
  if (denied) return denied;
  const now = Date.now();
  const summary = await processStaleJobs(await loadCandidates(now), now, staleJobDeps);
  const expiring = await flagExpiringAuthorizations(now);
  return Response.json({ ...summary, expiringAuthorizations: expiring }, { status: summary.errors.length ? 500 : 200 });
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
      // progress_events are customer-visible (job page, MCP, live feed): keep operator detail in interventions only.
      jobId: p.jobId, milestone: AUTH_FLAG, message: "We're finalizing your payment. No action is needed from you.",
    });
    await db().insert(schema.interventions).values({
      jobId: p.jobId, operatorEmail: "system@cron", kind: "other",
      note: "Per-finding authorization held over 5 days (Stripe holds expire after ~7 days). Capture or release it now.",
    });
    flagged.push(p.jobId);
  }
  return flagged;
}
