/** Pure helpers for scripts/stripe-setup.ts (unit-tested; no I/O, no secrets printed). */

export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
] as const;

export const VERCEL_ENVS = ["production", "preview", "development"] as const;

export type KeyMode = "test" | "live";

export function keyMode(key: string): KeyMode | null {
  if (/^(sk|rk)_test_./.test(key)) return "test";
  if (/^(sk|rk)_live_./.test(key)) return "live";
  return null;
}

/** Test keys always pass; live keys only with --live AND STRIPE_MODE=live. Throws otherwise. */
export function assertKeyAllowed(key: string | undefined, opts: { live: boolean; stripeMode?: string }): KeyMode {
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  const mode = keyMode(key);
  if (!mode) throw new Error("STRIPE_SECRET_KEY has an unrecognised prefix (expected sk_test_/rk_test_)");
  if (mode === "test") return mode;
  if (!opts.live || opts.stripeMode !== "live") {
    throw new Error("Refusing live key: requires both --live flag and STRIPE_MODE=live");
  }
  return mode;
}

export function maskSecret(s: string): string {
  if (s.length <= 12) return "****";
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/** Replace the NAME=... line (first match) or append; preserves all other lines. Returns new text. */
export function upsertEnvLine(text: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const lines = text === "" ? [] : text.split("\n");
  const re = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
  let replaced = false;
  const out: string[] = [];
  for (const l of lines) {
    if (re.test(l)) {
      if (!replaced) out.push(line);
      replaced = true; // drop duplicate definitions
    } else out.push(l);
  }
  if (!replaced) {
    if (out.length && out[out.length - 1] === "") out.splice(out.length - 1, 0, line);
    else out.push(line);
  }
  const res = out.join("\n");
  return res.endsWith("\n") ? res : res + "\n";
}

export function normalizeUrl(u: string): string {
  const url = new URL(u);
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("--url must be https");
  return url.origin;
}

export function webhookUrl(base: string): string {
  return `${normalizeUrl(base)}/api/stripe/webhook`;
}

export function sameEvents(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
}
