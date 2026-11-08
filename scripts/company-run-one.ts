/**
 * Run one company agent once in dry-run mode (no email transport in this process).
 *   cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx --tsconfig tsconfig.json ../../scripts/company-run-one.ts market_research
 */
import { existsSync, readFileSync } from "node:fs";
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
for (const k of ["AGENTMAIL_API_KEY", "RESEND_API_KEY", "EMAIL_FROM"]) delete process.env[k];
process.env.COMPANY_EMAIL_DRY_RUN = "1";

async function main(): Promise<void> {
  const { isCompanyAgentId } = await import("@ae/core/company/registry");
  const id = process.argv[2];
  if (!isCompanyAgentId(id)) { process.stdout.write("usage: company-run-one.ts <market_research|prospecting|outreach|onboarding|planner>\n"); return; }
  const { runAgentById } = await import("@/server/company/agents");
  const r = await runAgentById(id, { trigger: "manual", dryRun: true, ignoreToggle: true });
  process.stdout.write(`${JSON.stringify(r, null, 2).slice(0, 4000)}\n`);
}
main().catch((e) => { process.stdout.write(`failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
