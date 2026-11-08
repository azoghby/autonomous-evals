import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { stripe } from "@ae/core/payments/stripe";
import { getCurrentCustomer } from "@/server/queries";
import { jsonError } from "@/server/http";

export const dynamic = "force-dynamic";

/** Opens the Stripe customer billing portal (manage card, invoices, cancel). Returns { url }. */
export async function POST(request: Request): Promise<Response> {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Sign in to continue", { signinUrl: "/signin?next=/settings/billing" });

  const [row] = await db().select({ stripeCustomerId: schema.customers.stripeCustomerId })
    .from(schema.customers).where(eq(schema.customers.id, me.id)).limit(1);
  if (!row?.stripeCustomerId) {
    return jsonError(409, "No billing account yet — choose a plan first", { href: "/pricing" });
  }

  const origin = (process.env.APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
  try {
    const session = await stripe().billingPortal.sessions.create({
      customer: row.stripeCustomerId,
      return_url: `${origin}/settings/billing`,
    });
    return Response.json({ url: session.url });
  } catch (err) {
    console.error("billing portal failed", err instanceof Error ? err.message : err);
    return jsonError(502, "The billing portal is unavailable right now. Please try again later or contact support.");
  }
}
