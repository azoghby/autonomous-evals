/**
 * Live E2E for the Customer Success / Onboarding company agent, through the real agent + sandbox engine + Postgres
 * (sandbox workflow steps run inline instead of on the Workflow runtime). Fixture customer sandbox-e2e@example.com
 * talks to the agent over the in-app chat channel (3 messages), then the follow-through cron logic is polled until the
 * run is reported. Email is forced into dry-run (COMPANY_EMAIL_DRY_RUN=1): nothing is ever sent.
 * SPENDS REAL MONEY (onboarding model calls + suite generation + one tiny run: 2 trials, prebuilt acme-support world,
 * target openai/gpt-5-mini). Suite/run caps: SANDBOX_SUITE_BUDGET_USD (default 0.8), SANDBOX_RUN_BUDGET_USD (default 1.2).
 *
 *   cd apps/web && SANDBOX_LIVE=1 NODE_OPTIONS=--conditions=react-server npx tsx --tsconfig tsconfig.json ../../scripts/company-onboarding-e2e.ts
 *
 * Prints conversation status, run id, pass rates and total cost. Never prints secrets.
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
// Never send real email from this script, regardless of what .env says.
process.env.COMPANY_EMAIL_DRY_RUN = "1";

const EMAIL = "sandbox-e2e@example.com";
const POLL_MS = 15_000;
const TIMEOUT_MS = 10 * 60 * 1000;
const MESSAGES = [
  "Hi! I'd like to run an eval on my customer support agent. It runs on openai/gpt-5-mini.",
  "Its system prompt is: \"You are the customer support agent for Acme. Help customers with orders, refunds and tickets using the tools, and follow the refund policy exactly.\" For tools, please use your Acme sample world.",
  "That's everything I have. Please go ahead and create the sandbox and run it.",
];

const out = (s: string) => process.stdout.write(`${[process.env.AI_GATEWAY_API_KEY, process.env.NEON_API_KEY].reduce((a, k) => (k ? a.split(k).join("[redacted]") : a), s)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (process.env.SANDBOX_LIVE !== "1") { out("set SANDBOX_LIVE=1 to run (spends real money)"); return; }
  const { and, gte, like, sql } = await import("drizzle-orm");
  const { db, schema } = await import("@ae/core/db/client");
  const { createEngineSandboxService } = await import("@/server/sandbox/engine-service");
  const { createDbSandboxStore } = await import("@/server/sandbox/store");
  const { defaultPipelineDeps, runRunInline, runSuiteInline } = await import("@/server/sandbox/pipeline");
  const { checkIntegrationTargets } = await import("@/server/sandbox-service");
  const { getCustomerPlan } = await import("@ae/core/payments/plans-checkout");
  const { ESTIMATED_TRIAL_MICRO_USD } = await import("@ae/core/company/onboarding");
  const { summarizeRun } = await import("@ae/core/company/onboarding-report");
  const { handleOnboardingMessage, runOnboardingFollowThrough } = await import("@/server/company/onboarding");
  const { drizzleOnboardingStore } = await import("@/server/company/onboarding-store");

  const d = db();
  await d.insert(schema.customers).values({ email: EMAIL, name: "Sandbox E2E", source: "walk_up", isInternalFixture: true }).onConflictDoNothing();
  const [owner] = await d.select().from(schema.customers).where(sql`lower(${schema.customers.email}) = ${EMAIL}`).limit(1);
  if (!owner) throw new Error("fixture customer missing");
  await d.update(schema.customers).set({ isInternalFixture: true }).where(sql`${schema.customers.id} = ${owner.id}`);

  const store = createDbSandboxStore();
  const pipeline = defaultPipelineDeps(store);
  const pending: Promise<void>[] = [];
  const service = createEngineSandboxService({
    store,
    executor: {
      async startSuite(id) { pending.push(runSuiteInline(pipeline, id)); return null; },
      async startRun(id) { pending.push(runRunInline(pipeline, id).then(() => undefined)); return null; },
    },
    sampleReport: async () => null,
    checkTarget: (i) => checkIntegrationTargets(i),
    planFor: (ownerId) => getCustomerPlan(ownerId),
    suiteBudgetMicroUsd: Math.round(Number(process.env.SANDBOX_SUITE_BUDGET_USD ?? "0.8") * 1e6),
    runBudgetMicroUsd: Math.round(Number(process.env.SANDBOX_RUN_BUDGET_USD ?? "1.2") * 1e6),
  });
  const drain = async () => { while (pending.length) await pending.shift(); };
  // Keep spend tiny: an allowance of 2 trials makes the agent shrink the run to 2 scenarios x k=1.
  const deps = {
    sandbox: () => service,
    allowance: async () => ({ headroomMicroUsd: 2 * ESTIMATED_TRIAL_MICRO_USD, runCapMicroUsd: Math.round(Number(process.env.SANDBOX_RUN_BUDGET_USD ?? "1.2") * 1e6) }),
  };
  const opts = { dryRun: true, ignoreToggle: true } as const;
  const t0 = new Date();
  const secs = () => `${Math.round((Date.now() - t0.getTime()) / 1000)}s`;

  let conversationId: string | undefined;
  for (const [i, text] of MESSAGES.entries()) {
    const r = await handleOnboardingMessage({ customerId: owner.id, channel: "chat", text, conversationId }, { ...opts, trigger: "chat" }, deps);
    conversationId = r.conversationId || conversationId;
    out(`[${secs()}] message ${i + 1}: run=${r.result.status} conversation=${r.conversationId} status=${r.status}`);
    out(`  agent: ${r.reply.replace(/\s+/g, " ").slice(0, 400)}`);
    if (r.status === "building") break;
  }
  if (!conversationId) throw new Error("no conversation was created");
  const conv0 = await drizzleOnboardingStore().getConversation(conversationId);
  if (conv0?.status !== "building") throw new Error(`expected status building after the messages, got ${conv0?.status}`);
  out(`environment=${conv0.environmentId} suite=${conv0.suiteId}`);

  const deadline = Date.now() + TIMEOUT_MS;
  let conv = conv0;
  while (Date.now() < deadline && conv.status !== "reported" && conv.status !== "blocked") {
    await drain();
    const r = await runOnboardingFollowThrough({ trigger: "manual", ...opts }, deps);
    conv = (await drizzleOnboardingStore().getConversation(conversationId))!;
    out(`[${secs()}] follow-through: run=${r.status} conversation=${conv.status} runId=${conv.runId ?? "-"}`);
    if (conv.status === "building" || conv.status === "running") await sleep(POLL_MS);
  }
  await drain();
  conv = (await drizzleOnboardingStore().getConversation(conversationId))!;

  let runCost = 0;
  if (conv.runId) {
    const report = await service.getRunReport(owner.id, conv.runId);
    if (report) {
      const s = summarizeRun(report);
      runCost = report.costMicroUsd ?? 0;
      out(`run ${conv.runId} status=${report.status} scenarios=${s.scenarios} trials=${s.trials} pass@1=${s.passAt1.toFixed(2)} pass^k=${s.passHatK.toFixed(2)} ci95=[${s.ci95.map((x) => x.toFixed(2)).join(",")}]`);
      out(`run page: /sandbox/runs/${conv.runId}`);
    }
  }
  const c = schema.costs;
  const [agentCost] = await d.select({ total: sql<string>`coalesce(sum(${c.microUsd}), 0)` }).from(c)
    .where(and(like(c.agent, "company:onboarding"), gte(c.createdAt, t0)));
  const last = conv.transcript.at(-1);
  out(`FINAL conversation=${conv.id} status=${conv.status} reportedAt=${conv.reportedAt?.toISOString() ?? "-"} runId=${conv.runId ?? "-"}`);
  out(`last agent message:\n${last?.text ?? "-"}`);
  out(`TOTAL cost: onboarding agent $${(Number(agentCost?.total ?? 0) / 1e6).toFixed(3)} + sandbox run $${(runCost / 1e6).toFixed(3)} (suite generation cost is billed to the sandbox suite, see /sandbox)`);
  if (conv.status !== "reported") throw new Error(`conversation ended as "${conv.status}", not "reported"`);
}

main().then(() => process.exit(0), (e: unknown) => { out(`e2e failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(1); });
