/**
 * Live smoke (manual, SANDBOX_LIVE=1): acme-support → generate 3 → gates → run k=2 vs a public model.
 *   SANDBOX_LIVE=1 npx tsx --env-file=.env packages/core/src/sandbox/engine/smoke.live.ts
 * Spends real money (cap SMOKE_BUDGET_USD, default 1.5). Never prints the API key.
 */
import { generateStructured, generateText } from "../../ai/gateway";
import { buildAcmeSupport } from "../ingest/acme";
import { createNeonSandboxRuntime } from "../runtime/runtime";
import { createGatewaySimulator } from "../runtime/simulate";
import { gateSuite, generateScenarios, runSuite, summarizeSuite, budgetContext, type GeneratedScenario } from "./index";

async function main(): Promise<void> {
  if (process.env.SANDBOX_LIVE !== "1") { process.stdout.write("set SANDBOX_LIVE=1 to run\n"); return; }
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) throw new Error("AI_GATEWAY_API_KEY missing");
  const budget = Math.round(Number(process.env.SMOKE_BUDGET_USD ?? "1.5") * 1_000_000);
  const out = (s: string) => process.stdout.write(`${s.split(apiKey).join("[redacted]")}\n`);
  const ctx = budgetContext({ recordCost: async () => undefined }, budget);
  const deps = { gateway: { generateStructured, generateText }, ctx };
  const t0 = Date.now();

  const { spec: env, report: build } = await buildAcmeSupport();
  out(`env ${env.id}: ${env.tools.length} tools, ${env.workflows.length} workflows, warnings=${build.warnings.length}`);

  const generated: GeneratedScenario[] = [];
  for (const category of ["happy_path", "boundary", "injection"] as const) {
    const g = await generateScenarios(env, deps, { count: 1, categories: [category] });
    generated.push(...g.scenarios);
    for (const f of g.failures) out(`generation failed (${category}): ${f.error.slice(0, 300)}`);
  }
  out(`generated ${generated.length} scenarios; spent $${(ctx.spentMicroUsd() / 1e6).toFixed(3)}`);

  const runtime = createNeonSandboxRuntime({ branchTtlHours: 2, simulate: createGatewaySimulator({ ctx, model: "haiku", frozenNow: env.state.frozenNow }) });
  const jobId = `smoke_${Date.now().toString(36)}`;
  const gates = await gateSuite(env, generated, runtime, deps, { jobId: `${jobId}_g`, concurrency: 1 });
  for (const r of gates.reports) {
    out(`gate ${r.scenarioId}: accepted=${r.accepted} oracle=${r.oracle.passed} nulls=${r.nullAgents.map((n) => `${n.agent}:${n.passed ? "PASS" : "fail"}`).join(",")} mutations=${r.mutations.map((m) => `${m.kind}:${m.flipped}`).join(",")}`);
    for (const reason of r.reasons) out(`   reason: ${reason.slice(0, 300)}`);
  }
  out(`gates done; spent $${(ctx.spentMicroUsd() / 1e6).toFixed(3)}`);

  // Run accepted scenarios; if the gates accepted none, still exercise the runner on the generated ones (flagged).
  const suite = gates.accepted.length ? gates.accepted : generated.map((g) => g.scenario);
  if (!gates.accepted.length) out("NOTE: no scenario passed the gates; running unvalidated scenarios to exercise the runner");
  const results = await runSuite(env, suite, runtime, { endpointUrl: "https://ai-gateway.vercel.sh/v1/chat/completions", model: "openai/gpt-5-mini", apiKey, maxCompletionTokens: 4000 }, {
    deps, k: 2, concurrency: 2, budgetMicroUsd: Math.max(0, budget - ctx.spentMicroUsd()), jobId: `${jobId}_r`, runtimeName: "neon-template",
  });
  for (const r of results) {
    out(`result ${r.scenarioId}: passRate=${r.passRate.toFixed(2)} pass^k=${r.reliable} ci95=[${r.ci95.map((x) => x.toFixed(2)).join(",")}]`);
    for (const t of r.trials) {
      const failed = t.checks.filter((c) => !c.passed).map((c) => c.id);
      out(`   trial ${t.trial} (${t.variant}) passed=${t.passed} attribution=${t.failureAttribution ?? "-"} tools=${t.toolCalls.map((c) => c.tool).join(">")} failed=[${failed.join(",")}]${t.error ? ` error=${t.error}` : ""}`);
    }
  }
  const sum = summarizeSuite(suite, results);
  out(`summary pass@1=${sum.passAt1.toFixed(2)} pass^k=${sum.passHatK.toFixed(2)} security=${JSON.stringify(sum.security)}`);
  out(`versions ${JSON.stringify(results[0]?.trials[0]?.versions)}`);
  out(`our spend $${(ctx.spentMicroUsd() / 1e6).toFixed(3)} (target model spend not metered), ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch((e: unknown) => {
  const key = process.env.AI_GATEWAY_API_KEY ?? "";
  process.stderr.write(`smoke failed: ${String(e instanceof Error ? e.stack ?? e.message : e).split(key || "\u0000").join("[redacted]")}\n`);
  process.exit(1);
});
