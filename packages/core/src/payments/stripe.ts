import Stripe from "stripe";

export type StripeMode = "test" | "live";

/** Reads STRIPE_MODE (default "test"). Anything else is a configuration error. */
export function getStripeMode(env: NodeJS.ProcessEnv = process.env): StripeMode {
  const mode = (env.STRIPE_MODE ?? "test").trim();
  if (mode !== "test" && mode !== "live") throw new Error(`STRIPE_MODE must be "test" or "live", got "${mode}"`);
  return mode;
}

/** Which environment a secret/restricted key belongs to, or null if the prefix is unrecognised. */
export function keyModeOf(key: string): StripeMode | null {
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  return null;
}

/** Refuses to run when the key's environment does not match STRIPE_MODE. Never echoes the key. */
export function assertKeyMatchesMode(key: string, mode: StripeMode): void {
  const actual = keyModeOf(key);
  if (!actual) throw new Error("STRIPE_SECRET_KEY has an unrecognised prefix (expected sk_test_/sk_live_/rk_test_/rk_live_)");
  if (actual !== mode) throw new Error(`Refusing to run: STRIPE_MODE=${mode} but STRIPE_SECRET_KEY is a ${actual}-mode key`);
}

let cached: { key: string; client: Stripe } | undefined;

/** Lazy client. Throws a clear error at request time (never at import time) when misconfigured. */
export function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  assertKeyMatchesMode(key, getStripeMode());
  if (cached?.key !== key) cached = { key, client: new Stripe(key, { maxNetworkRetries: 2 }) };
  return cached.client;
}

export function webhookSecret(): string {
  const s = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  return s;
}
