/**
 * Live Sandbox Evals E2E through the real service + pipeline + Postgres (steps run inline instead of on the
 * Workflow runtime): prebuilt acme-support, target openai/gpt-5-mini via AI Gateway, k=2.
 * SPENDS REAL MONEY (suite cap SANDBOX_SUITE_BUDGET_USD default $0.80, run cap SANDBOX_RUN_BUDGET_USD default $1.20).
 *   cd apps/web && SANDBOX_LIVE=1 NODE_OPTIONS=--conditions=react-server npx tsx --tsconfig tsconfig.json ../../scripts/sandbox-live-e2e.ts
 * Prints ids, per-scenario results and cost. Never prints secrets.
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

const EMAIL = "sandbox-e2e@example.com";
const out = (s: string) => process.stdout.write(`${[process.env.AI_GATEWAY_API_KEY, process.env.NEON_API_KEY].reduce((a, k) => (k ? a.split(k).join("[redacted]") : a), s)}\n`);

async function main(): Promise<void> {
  if (process.env.SANDBOX_LIVE !== "1") { out("set SANDBOX_LIVE=1 to run (spends real money)"); return; }
  const { eq, sql } = await import("drizzle-orm");
  const { db, schema } = await import("@ae/core/db/client");
  const { PREBUILT_ENV_FILES } = await import("@ae/core/sandbox/ingest/prebuilt-files.generated");
  const { createEngineSandboxService } = await import("@/server/sandbox/engine-service");
  const { createDbSandboxStore } = await import("@/server/sandbox/store");
  const { defaultPipelineDeps, runRunInline, runSuiteInline } = await import("@/server/sandbox/pipeline");
  const { checkIntegrationTargets } = await import("@/server/sandbox-service");
  const { GATEWAY_TARGET_URL } = await import("@/components/sandbox/contract");

  const d = db();
  await d.insert(schema.customers).values({ email: EMAIL, name: "Sandbox E2E", source: "walk_up", isInternalFixture: true }).onConflictDoNothing();
  const [owner] = await d.select().from(schema.customers).where(sql`lower(${schema.customers.email}) = ${EMAIL}`).limit(1);
  if (!owner) throw new Error("fixture customer missing");

  const store = createDbSandboxStore();
  const pipeline = defaultPipelineDeps(store);
  const pending: Promise<void>[] = [];
  const service = createEngineSandboxService({
    store,
    executor: {
      async startSuite(id) { pending.push(runSuiteInline(pipeline, id)); return null; },
      async startRun(id) { pending.push(runRunInline(pipeline, id)); return null; },
    },
    sampleReport: async () => null,
    checkTarget: (i) => checkIntegrationTargets(i),
    suiteBudgetMicroUsd: Math.round(Number(process.env.SANDBOX_SUITE_BUDGET_USD ?? "0.8") * 1e6),
    runBudgetMicroUsd: Math.round(Number(process.env.SANDBOX_RUN_BUDGET_USD ?? "1.2") * 1e6),
  });
  const drain = async () => { while (pending.length) await pending.shift(); };
  const t0 = Date.now();
  const secs = () => `${Math.round((Date.now() - t0) / 1000)}s`;

  const systemPrompt = [
    "You are the customer support agent for Acme. Help customers with orders, refunds and tickets using the tools.",
    "Follow these policies exactly:", PREBUILT_ENV_FILES["acme-support"]!["policies.md"],
  ].join("\n\n");
  const draft = await service.createDraft(owner.id, {
    name: "Acme Support (gpt-5-mini)", domain: "customer support: orders, refunds, tickets", prebuilt: "acme-support",
    integration: { mode: "tool_loop", endpointUrl: GATEWAY_TARGET_URL, model: "openai/gpt-5-mini", systemPrompt },
  });
  out(`draft ${draft.draftId} env ${draft.environmentId} status=${draft.status} tools=${draft.environment.tools.length}`);
  await drain();
  const ready = await service.getDraft(owner.id, draft.draftId);
  if (!ready || ready.status !== "ready") throw new Error(`suite not ready: ${ready?.status} ${ready?.error ?? ""}`);
  out(`suite ready in ${secs()}; cost $${((ready.costMicroUsd ?? 0) / 1e6).toFixed(3)}`);
  for (const s of ready.scenarios) out(`  ${s.scenario.id} [${s.scenario.category}] validated=${s.validated} ${s.gateReasons?.join(" | ").slice(0, 240) ?? ""}`);

  const validated = ready.scenarios.filter((s) => s.validated);
  const toRun = validated.length ? validated : ready.scenarios;
  if (!validated.length) out("NOTE: no scenario passed the gates; running unvalidated scenarios (marked in the report)");
  for (const s of toRun) await service.reviewScenario(owner.id, draft.draftId, s.scenario.id, { decision: "accepted" });
  const started = await service.startRun(owner.id, draft.draftId, { k: 2 });
  if (!started.ok) throw new Error(`startRun: ${started.error}`);
  out(`run ${started.runId} started`);
  await drain();
  const report = await service.getRunReport(owner.id, started.runId);
  if (!report) throw new Error("report missing");
  out(`run status=${report.status} in ${secs()} cost=$${((report.costMicroUsd ?? 0) / 1e6).toFixed(3)} / $${((report.budgetMicroUsd ?? 0) / 1e6).toFixed(2)}${report.error ? ` note="${report.error}"` : ""}`);
  for (const r of report.results) {
    out(`  ${r.scenarioId}: passRate=${r.passRate.toFixed(2)} pass^k=${r.reliable} ci95=[${r.ci95.map((x) => x.toFixed(2)).join(",")}]`);
    for (const t of r.trials) out(`     trial ${t.trial} (${t.variant}) passed=${t.passed} attr=${t.failureAttribution ?? "-"} tools=${t.toolCalls.map((c) => c.tool).join(">")} failed=[${t.checks.filter((c) => !c.passed).map((c) => c.id).join(",")}]${t.error ? ` error=${t.error}` : ""}`);
  }
  const [row] = await d.select().from(schema.sandboxRuns).where(eq(schema.sandboxRuns.id, started.runId));
  out(`summary pass@1=${row?.passAt1?.toFixed(2)} pass^k=${row?.passHatK?.toFixed(2)} wilson95=[${row?.ci95Low?.toFixed(2)},${row?.ci95High?.toFixed(2)}] clusters=${report.clusters.length}`);
  out(`TOTAL our spend $${(((ready.costMicroUsd ?? 0) + (report.costMicroUsd ?? 0)) / 1e6).toFixed(3)}; run page: /sandbox/runs/${started.runId}`);
}

main().then(() => process.exit(0), (e: unknown) => { out(`e2e failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(1); });
