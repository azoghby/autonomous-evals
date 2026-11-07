import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { PER_FINDING_CAP_CENTS, PricingMode } from "@ae/core/contracts/index";
import { createCheckoutForQuote } from "@ae/core/payments/checkout";
import { stripe } from "@ae/core/payments/stripe";
import { jsonError, readJson, isUuid } from "@/server/http";
import { getCurrentCustomer } from "@/server/queries";
import { latestQuote } from "@/server/job-store";
import { sendJobEvent } from "@/workflows/events";

export const dynamic = "force-dynamic";
const Body = z.object({ quoteVersion: z.int().positive(), pricingMode: PricingMode.optional() });

export async function POST(request: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  const { jobId } = await ctx.params;
  if (!isUuid(jobId)) return jsonError(404, "Job not found");
  const body = await readJson(request, Body);
  if (!body.ok) return body.res;

  const [job] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  // Owner only (operators do not accept quotes on a customer's behalf). Same 404 as missing to avoid leaking existence.
  if (!job || job.customerId !== me.id) return jsonError(404, "Job not found");
  if (job.state !== "quoted" && job.state !== "awaiting_payment") return jsonError(409, "Job is not waiting on a quote", { state: job.state });

  const quote = await latestQuote(jobId);
  if (!quote || quote.version !== body.data.quoteVersion) {
    return jsonError(409, "That quote is out of date", { latestVersion: quote?.version ?? null });
  }

  // Omitted mode keeps the quote's current mode (default fixed). A different mode replaces an open session.
  const pricingMode: PricingMode = body.data.pricingMode ?? (quote.pricingMode as PricingMode);
  const modeChanged = pricingMode !== quote.pricingMode;
  const capCents = pricingMode === "per_finding" ? PER_FINDING_CAP_CENTS[quote.package] : null;
  const chargeCents = pricingMode === "per_finding" ? capCents! : quote.priceCents;

  await db().update(schema.quotes).set({ acceptedAt: sql`coalesce(${schema.quotes.acceptedAt}, now())` })
    .where(eq(schema.quotes.id, quote.id));

  const origin = (process.env.APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
  let checkoutUrl: string | null = null;
  try {
    let retryAfterSessionId: string | undefined;
    if (quote.stripeCheckoutSessionId) {
      const existing = await stripe().checkout.sessions.retrieve(quote.stripeCheckoutSessionId);
      if (existing.payment_status === "paid" || existing.status === "complete") return jsonError(409, "This quote is already paid");
      if (existing.status === "open" && existing.url && !modeChanged) checkoutUrl = existing.url;
      else {
        if (existing.status === "open") await stripe().checkout.sessions.expire(existing.id);
        retryAfterSessionId = existing.id; // expired: a fresh idempotency key is required
      }
    }
    if (!checkoutUrl) {
      const created = await createCheckoutForQuote({
        jobId, quoteVersion: quote.version, priceCents: chargeCents, pricingMode, customerEmail: me.email,
        successUrl: `${origin}/jobs/${jobId}?checkout=success`, cancelUrl: `${origin}/jobs/${jobId}?checkout=cancelled`,
        productName: `Autonomous Evals: ${quote.package.replace(/_/g, " ")}`, retryAfterSessionId,
      });
      await db().update(schema.quotes).set({ stripeCheckoutSessionId: created.sessionId, pricingMode, capCents })
        .where(and(eq(schema.quotes.id, quote.id), quote.stripeCheckoutSessionId ? eq(schema.quotes.stripeCheckoutSessionId, quote.stripeCheckoutSessionId) : isNull(schema.quotes.stripeCheckoutSessionId)));
      checkoutUrl = created.url;
    }
  } catch (err) {
    console.error("accept-quote checkout failed", jobId, err instanceof Error ? err.message : err);
    return jsonError(502, "Could not start checkout. Please try again.");
  }

  if (job.state === "quoted") {
    try {
      await sendJobEvent(jobId, { type: "quote_accepted", quoteVersion: quote.version });
    } catch (err) {
      console.error("accept-quote sendJobEvent failed", jobId, err instanceof Error ? err.message : err);
      return jsonError(502, "Checkout was created but the job could not be notified; please retry");
    }
  }
  return Response.json({ checkoutUrl, pricingMode, capCents });
}
