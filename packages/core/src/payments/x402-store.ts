import { and, eq, like } from "drizzle-orm";
import { db, schema } from "../db/client";
import type { PaymentRow } from "./checkout";
import { X402_CURRENCY, X402_SESSION_PREFIX, x402SessionKey, type X402PaymentValues } from "./x402";

export interface RecordX402Args extends X402PaymentValues {
  jobId: string;
  quoteVersion: number;
}

/**
 * Persists a settled x402 payment. Idempotent on the transaction hash: the tx-derived key lives in the unique
 * stripe_checkout_session_id column, so a replay returns the existing row with inserted=false.
 * x402 is testnet-only, so environment is always 'test'.
 */
export async function recordX402Payment(a: RecordX402Args): Promise<{ payment: PaymentRow; inserted: boolean }> {
  const key = x402SessionKey(a.network, a.txHash);
  const rows = await db().insert(schema.payments).values({
    jobId: a.jobId, quoteVersion: a.quoteVersion,
    stripeCheckoutSessionId: key, stripeEventId: null, stripePaymentIntentId: null,
    amountCents: a.amountCents, currency: X402_CURRENCY,
    environment: "test", kind: "one_time", status: "paid",
  }).onConflictDoNothing().returning();
  if (rows[0]) return { payment: rows[0], inserted: true };
  const [existing] = await db().select().from(schema.payments)
    .where(eq(schema.payments.stripeCheckoutSessionId, key)).limit(1);
  if (!existing) throw new Error(`x402 payment ${a.txHash} conflicted but could not be found`);
  if (existing.jobId !== a.jobId) throw new Error(`x402 transaction ${a.txHash} is already recorded for another job`);
  return { payment: existing, inserted: false };
}

/** The x402 payment already recorded for this job's quote version, if any. */
export async function findX402PaymentForQuote(jobId: string, quoteVersion: number): Promise<PaymentRow | null> {
  const [row] = await db().select().from(schema.payments).where(and(
    eq(schema.payments.jobId, jobId), eq(schema.payments.quoteVersion, quoteVersion),
    like(schema.payments.stripeCheckoutSessionId, `${X402_SESSION_PREFIX}%`),
  )).limit(1);
  return row ?? null;
}
