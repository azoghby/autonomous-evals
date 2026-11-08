import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { createAuditCheckout, createPlanCheckout, effectivePlanFor, resolvePriceId, syncSubscription } from "@ae/core/payments/plans-checkout";
import { changePlanSubscription } from "@ae/core/payments/subscription-changes";
import { BILLING_INTERVALS, SELF_SERVE_PLAN_IDS, trialDaysFor } from "@ae/core/pricing/plans";
import { getCurrentCustomer } from "@/server/queries";
import { jsonError, readJson } from "@/server/http";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), plan: z.enum(SELF_SERVE_PLAN_IDS), interval: z.enum(BILLING_INTERVALS) }),
  z.object({ kind: z.literal("audit") }),
]);

/** Starts a Stripe Checkout for a Pro/Scale subscription or the one-off Agent Audit. Returns { url }. */
export async function POST(request: Request) {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Sign in to continue", { signinUrl: "/signin?next=/pricing" });
  const body = await readJson(request, Body);
  if (!body.ok) return body.res;
  const input = body.data;

  const origin = (process.env.APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
  const cancelUrl = `${origin}/pricing?checkout=cancelled`;
  try {
    if (input.kind === "audit") {
      const { url } = await createAuditCheckout({
        customerId: me.id, customerEmail: me.email, cancelUrl, successUrl: `${origin}/pricing?checkout=success&plan=agent_audit`,
      });
      return Response.json({ url });
    }
    const [row] = await db().select({
      plan: schema.customers.plan, planStatus: schema.customers.planStatus, planInterval: schema.customers.planInterval,
      stripeCustomerId: schema.customers.stripeCustomerId, stripeSubscriptionId: schema.customers.stripeSubscriptionId,
    }).from(schema.customers).where(eq(schema.customers.id, me.id)).limit(1);
    const current = row ? effectivePlanFor(row) : "developer";
    if (current === input.plan && (row?.planInterval ?? "month") === input.interval) {
      return jsonError(409, `You are already on the ${input.plan === "pro" ? "Pro" : "Scale"} plan. Manage it from /settings/billing.`);
    }
    if ((current === "pro" || current === "scale") && row?.stripeSubscriptionId) {
      // Switch the existing subscription in place (prorated) so the old plan never keeps billing alongside the new one.
      const updated = await changePlanSubscription(
        { customerId: me.id, stripeSubscriptionId: row.stripeSubscriptionId, plan: input.plan, interval: input.interval }, resolvePriceId,
      );
      await syncSubscription(updated);
      return Response.json({ url: `${origin}/settings/billing?changed=${input.plan}`, changed: true });
    }
    // One free trial per account: any earlier subscription (even a lapsed one) uses it up.
    const [prior] = row?.stripeSubscriptionId ? [true] : await db().select({ id: schema.planPurchases.id }).from(schema.planPurchases)
      .where(and(eq(schema.planPurchases.customerId, me.id), eq(schema.planPurchases.kind, "subscription"))).limit(1);
    const trialDays = trialDaysFor(input.plan, { hadSubscription: !!prior });
    const { url } = await createPlanCheckout({
      trialDays,
      customerId: me.id, customerEmail: me.email, stripeCustomerId: row?.stripeCustomerId ?? null,
      plan: input.plan, interval: input.interval, cancelUrl,
      successUrl: `${origin}/pricing?checkout=success&plan=${input.plan}`,
    });
    return Response.json({ url });
  } catch (err) {
    console.error("billing checkout failed", input.kind, err instanceof Error ? err.message : err);
    return jsonError(502, "Could not start checkout. Please try again.");
  }
}
