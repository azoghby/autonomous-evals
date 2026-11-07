/**
 * One-command Stripe setup.
 *   STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/stripe-setup.ts [--url https://autonomous-evals.vercel.app] [--recreate] [--no-vercel] [--live]
 * Creates (or finds) the webhook endpoint, writes env files, pushes env to Vercel. Never prints secrets.
 */
import Stripe from "stripe";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERCEL_ENVS, WEBHOOK_EVENTS, assertKeyAllowed, maskSecret, sameEvents, upsertEnvLine, webhookUrl } from "./stripe-setup-lib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = "agents-db31";
const DEFAULT_URL = "https://autonomous-evals.vercel.app";
const ENV_FILES = [resolve(ROOT, ".env"), resolve(ROOT, "apps/web/.env.local")];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (n: string) => process.argv.includes(n);

function writeEnv(file: string, vars: Record<string, string>): void {
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  for (const [k, v] of Object.entries(vars)) text = upsertEnvLine(text, k, v);
  writeFileSync(file, text, { mode: 0o600 });
}

function vercelEnvAdd(name: string, env: string, value: string): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn("vercel", ["env", "add", name, env, "--scope", SCOPE, "--force"], { cwd: resolve(ROOT, "apps/web"), stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", rej);
    p.on("close", (code) => (code === 0 ? res() : rej(new Error(`vercel env add ${name} ${env} exit ${code}: ${err.replaceAll(value, "***").slice(-300)}`))));
    p.stdin.end(value);
  });
}

async function main(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY;
  const mode = assertKeyAllowed(key, { live: flag("--live"), stripeMode: process.env.STRIPE_MODE });
  const url = webhookUrl(arg("--url") ?? DEFAULT_URL);
  console.log(`Mode: ${mode}  Key: ${maskSecret(key!)}  Endpoint: ${url}`);

  const client = new Stripe(key!, { maxNetworkRetries: 2 });
  const events = [...WEBHOOK_EVENTS] as Stripe.WebhookEndpointCreateParams.EnabledEvent[];
  const existing = (await client.webhookEndpoints.list({ limit: 100 })).data.find((e) => e.url === url);

  let secret: string | undefined;
  if (existing && flag("--recreate")) {
    await client.webhookEndpoints.del(existing.id);
    console.log(`Deleted old endpoint ${existing.id} (--recreate)`);
  }
  if (existing && !flag("--recreate")) {
    console.log(`Endpoint exists: ${existing.id} (${existing.status})`);
    if (!sameEvents(existing.enabled_events, WEBHOOK_EVENTS) || existing.status !== "enabled") {
      await client.webhookEndpoints.update(existing.id, { enabled_events: events, disabled: false });
      console.log("Updated enabled events / re-enabled endpoint.");
    }
    console.log("Signing secret is only shown at creation; keeping existing STRIPE_WEBHOOK_SECRET. Use --recreate to rotate.");
  } else {
    const created = await client.webhookEndpoints.create({
      url, enabled_events: events, description: "Autonomous Evals payments", metadata: { app: "autonomous-evals" },
    });
    secret = created.secret;
    console.log(`Created endpoint ${created.id}; signing secret ${maskSecret(secret ?? "")}`);
  }

  const vars: Record<string, string> = { STRIPE_SECRET_KEY: key! };
  if (secret) vars.STRIPE_WEBHOOK_SECRET = secret;
  for (const f of ENV_FILES) {
    writeEnv(f, vars);
    console.log(`Wrote ${Object.keys(vars).join(", ")} -> ${f.replace(ROOT + "/", "")}`);
  }

  if (flag("--no-vercel")) console.log("Skipped Vercel (--no-vercel).");
  else {
    for (const [name, value] of Object.entries(vars)) {
      for (const env of VERCEL_ENVS) {
        await vercelEnvAdd(name, env, value);
        console.log(`Vercel: ${name} -> ${env} ok`);
      }
    }
  }

  console.log(`\nNext steps:\n  cd ${ROOT} && vercel deploy --prod --yes --scope ${SCOPE}\n  then follow scripts/stripe-smoke.md`);
}

main().catch((e) => {
  console.error("stripe-setup failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
