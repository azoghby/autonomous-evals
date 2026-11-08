/**
 * Dev-only: mints a session cookie for the fixture customer sandbox-e2e@example.com without sending any email
 * (AUTH_DEV_LINKS=1 makes requestMagicLink return the link instead of emailing it). Writes the cookie to the path in
 * argv[2] (never prints it), plus the customer's plan, spend this month and the onboarding toggle.
 *
 *   cd apps/web && npx tsx --tsconfig tsconfig.json ../../scripts/mint-chat-session.ts /path/to/cookie.txt [email]
 *
 * With [email], mints for that EXISTING customer instead (never creates one).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [resolve(ROOT, "apps/web/.env.local"), resolve(ROOT, ".env")]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
process.env.AUTH_DEV_LINKS = "1";
delete process.env.VERCEL_ENV;

const FIXTURE_EMAIL = "sandbox-e2e@example.com";
const EMAIL = (process.argv[3] ?? FIXTURE_EMAIL).trim().toLowerCase();

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) throw new Error("usage: mint-chat-session.ts <cookie-file>");
  const { sql } = await import("drizzle-orm");
  const { db, schema } = await import("@ae/core/db/client");
  const { requestMagicLink, verifyMagicLink } = await import("@ae/core/auth/magic-link");
  const { getCustomerPlan } = await import("@ae/core/payments/plans-checkout");
  const d = db();
  if (EMAIL === FIXTURE_EMAIL) {
    await d.insert(schema.customers).values({ email: EMAIL, name: "Sandbox E2E", source: "walk_up", isInternalFixture: true }).onConflictDoNothing();
  } else {
    const [found] = await d.select({ id: schema.customers.id }).from(schema.customers).where(sql`lower(${schema.customers.email}) = ${EMAIL}`).limit(1);
    if (!found) throw new Error("no such customer; refusing to create one");
  }
  const { devLink } = await requestMagicLink(EMAIL);
  if (!devLink) throw new Error("dev link not returned; refusing to continue (would have emailed)");
  const token = new URL(devLink).searchParams.get("token")!;
  const v = await verifyMagicLink(token);
  if (!v.ok) throw new Error(`verify failed: ${JSON.stringify(v)}`);
  writeFileSync(out, `ae_session=${v.sessionToken}`, { mode: 0o600 });
  const plan = await getCustomerPlan(v.customerId);
  const toggles = await d.execute(sql`select * from company_agent_toggles where agent_id = 'onboarding'`).catch(() => ({ rows: [] }));
  process.stdout.write(`customer=${v.customerId} plan=${plan} onboardingToggle=${JSON.stringify(toggles.rows[0] ?? null)}\n`);
}

main().then(() => process.exit(0), (e: unknown) => { process.stdout.write(`mint failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
