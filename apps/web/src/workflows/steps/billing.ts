import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { settlePerFindingPayment } from "@ae/core/payments/checkout";
import { recordProgress } from "@/server/job-store";
import { settlementMessage } from "../decisions";

/** Confirmed findings of the original run (reruns excluded). Only status 'confirmed' is billable. */
export async function countConfirmedFindings(jobId: string): Promise<number> {
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.findings)
    .where(and(eq(schema.findings.jobId, jobId), isNull(schema.findings.rerunOfFindingId), sql`${schema.findings.data}->>'status' = 'confirmed'`));
  return row?.n ?? 0;
}

/**
 * Per-finding pricing settlement: capture $3 per confirmed finding (capped) or release the hold.
 * No-op for fixed-price jobs. Idempotent (Stripe idempotency keys + settled payment rows), so retries are safe.
 */
export async function settlePaymentStep(jobId: string): Promise<void> {
  "use step";
  const confirmed = await countConfirmedFindings(jobId);
  const result = await settlePerFindingPayment(jobId, confirmed);
  if (result.outcome === "captured" || result.outcome === "released") {
    await recordProgress(jobId, result.outcome === "captured" ? "payment_captured" : "payment_released",
      settlementMessage(result.confirmedCount, result.amountCents));
  }
}

/** Records an operator-visible intervention when settlement keeps failing; delivery itself is never undone. */
export async function flagSettlementFailureStep(jobId: string, error: string): Promise<void> {
  "use step";
  await db().insert(schema.interventions).values({
    jobId, operatorEmail: "system@workflow", kind: "other",
    note: `Per-finding payment settlement failed; the authorization is still held. Capture or release it manually. ${error.slice(0, 300)}`,
  });
  await recordProgress(jobId, "payment_settlement_failed", "Internal note: payment settlement needs operator attention.").catch(() => undefined);
}
