/* Run: npx tsx scripts/stripe-plan-checkout-smoke.ts   (test-mode key only; creates one Checkout Session, no DB writes) */
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { assertKeyAllowed } from "./stripe-setup-lib";

for (const f of [".env", "apps/web/.env.local", "apps/web/.env.vercel.local"]) config({ path: f, override: false, quiet: true });

async function main(): Promise<void> {
  assertKeyAllowed(process.env.STRIPE_SECRET_KEY, { live: false, stripeMode: process.env.STRIPE_MODE });
  const { createPlanCheckout } = await import("../packages/core/src/payments/plans-checkout");
  const { sessionId, url } = await createPlanCheckout({
    customerId: randomUUID(), customerEmail: "smoke+pro@example.com", plan: "pro", interval: "month",
    successUrl: "https://example.com/pricing?checkout=success&plan=pro", cancelUrl: "https://example.com/pricing?checkout=cancelled",
  });
  console.log(`session ${sessionId}\n${url}`);
}

main().catch((e) => {
  console.error("smoke failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
