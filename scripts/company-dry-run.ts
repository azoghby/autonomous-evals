/**
 * Live dry run of the agent-run company: market research -> prospecting -> outreach drafting -> planner.
 * Real web search + models + Monid + DB writes, capped at COMPANY_AGENTS_DAILY_BUDGET_USD (forced <= $2 here).
 * Email transports are REMOVED from this process (AGENTMAIL/RESEND keys unset), so nothing can be sent;
 * outreach lands in outreach_drafts as status "pending" (founder approval queue).
 *   cd apps/web && COMPANY_DRY_RUN_LIVE=1 NODE_OPTIONS=--conditions=react-server npx tsx --tsconfig tsconfig.json ../../scripts/company-dry-run.ts
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
// No transport, no sends: any accidental sendEmail() would throw instead of delivering.
for (const k of ["AGENTMAIL_API_KEY", "RESEND_API_KEY", "EMAIL_FROM"]) delete process.env[k];
process.env.COMPANY_EMAIL_DRY_RUN = "1";
const cap = Math.min(Number(process.env.COMPANY_AGENTS_DAILY_BUDGET_USD ?? 2) || 2, 2);
process.env.COMPANY_AGENTS_DAILY_BUDGET_USD = String(cap);

const secrets = [process.env.AI_GATEWAY_API_KEY, process.env.MONID_API_KEY, process.env.NEON_API_KEY];
const out = (s: string) => process.stdout.write(`${secrets.reduce((a, k) => (k ? a.split(k).join("[redacted]") : a), s)}\n`);

async function main(): Promise<void> {
  if (process.env.COMPANY_DRY_RUN_LIVE !== "1") { out("set COMPANY_DRY_RUN_LIVE=1 to run (spends up to $2)"); return; }
  const { and, eq, gte, inArray, sql } = await import("drizzle-orm");
  const { db, schema } = await import("@ae/core/db/client");
  const { runAgentById } = await import("@/server/company/agents");
  const started = new Date();
  const d = schema.outreachDrafts;
  const sentBefore = Number((await db().select({ n: sql<string>`count(*)` }).from(d).where(eq(d.status, "sent")))[0]?.n ?? 0);

  let total = 0;
  for (const id of ["market_research", "prospecting", "outreach", "planner"] as const) {
    const r = await runAgentById(id, { trigger: "manual", dryRun: true, ignoreToggle: true });
    const cost = "costMicroUsd" in r ? r.costMicroUsd : 0;
    total += cost;
    out(`\n== ${id}: ${r.status}${"reason" in r ? ` (${r.reason})` : ""}${"error" in r && r.error ? ` error=${r.error}` : ""} cost=$${(cost / 1e6).toFixed(4)}`);
    if ("outcome" in r && r.outcome) out(`   ${r.outcome.summary}\n   counts=${JSON.stringify(r.outcome.counts ?? {})}`);
  }

  const [brief] = await db().select().from(schema.marketBriefs).orderBy(sql`${schema.marketBriefs.createdAt} desc`).limit(1);
  const b = brief?.brief as { headline?: string; segments?: Array<{ segment: string; summary: string }>; competitors?: Array<{ name: string; pricing?: string }> } | undefined;
  if (b) {
    out(`\n-- Brief ${brief!.briefDate}: ${b.headline ?? ""}`);
    for (const s of (b.segments ?? []).slice(0, 2)) out(`   [${s.segment}] ${s.summary.slice(0, 220)}`);
    out(`   competitors: ${(b.competitors ?? []).slice(0, 6).map((c) => `${c.name}${c.pricing ? ` (${c.pricing.slice(0, 40)})` : ""}`).join("; ")}`);
    out(`   sources: ${(brief!.sources ?? []).length}`);
  }
  const leads = await db().select({ n: sql<string>`count(*)` }).from(schema.prospectLeads).where(gte(schema.prospectLeads.createdAt, started));
  const withContact = await db().select({ n: sql<string>`count(*)` }).from(schema.prospectLeads)
    .where(and(gte(schema.prospectLeads.createdAt, started), sql`${schema.prospectLeads.contactEmail} is not null`));
  const drafts = await db().select({ status: d.status, n: sql<string>`count(*)` }).from(d)
    .where(and(gte(d.createdAt, started), inArray(d.kind, ["sdr_first_touch", "sdr_follow_up"]))).groupBy(d.status);
  const sentAfter = Number((await db().select({ n: sql<string>`count(*)` }).from(d).where(eq(d.status, "sent")))[0]?.n ?? 0);
  const [plan] = await db().select().from(schema.companyPlans).orderBy(sql`${schema.companyPlans.createdAt} desc`).limit(1);
  out(`\n-- New leads: ${leads[0]?.n ?? 0} (with public work email: ${withContact[0]?.n ?? 0})`);
  out(`-- New SDR drafts by status: ${JSON.stringify(Object.fromEntries(drafts.map((x) => [x.status, Number(x.n)])))}`);
  out(`-- outreach_drafts status=sent before/after: ${sentBefore}/${sentAfter} (must be equal)`);
  if (plan) out(`-- Plan ${plan.planDate}:\n${plan.summary}`);
  out(`\nTOTAL company agent cost: $${(total / 1e6).toFixed(4)} (cap $${cap})`);
  if (sentAfter !== sentBefore) { out("FAIL: something was sent"); process.exitCode = 1; }
}

main().catch((e) => { out(`dry run failed: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
