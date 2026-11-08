/**
 * Oracle gate for data/envs/cs-agents-airline/scenarios.json, through the REAL sandbox runtime (Neon branch):
 *   per scenario: (1) replay the gold tool calls with run.callTool and grade (judge null) -> must PASS
 *                 (2) grade the untouched seed with an empty transcript -> must FAIL
 * Same approach as scripts/tau2/scenario-gate.ts, but live: prepare -> startRun -> callTool... -> gradeTrial.
 *
 *   SANDBOX_LIVE=1 npx tsx --env-file=.env scripts/demo/validate-cs-airline.ts
 *
 * No LLM calls. Exits 1 if any scenario fails the gate; only then should oracleValidated be false.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCsAgentsAirline } from "../../packages/core/src/sandbox/ingest/cs-agents-airline";
import { createNeonSandboxRuntime } from "../../packages/core/src/sandbox/runtime/runtime";
import { gradeTrial } from "../../packages/core/src/sandbox/engine/graders";
import { SandboxScenario, type EnvironmentSpec, type SandboxRuntime } from "../../packages/core/src/sandbox/spec";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
interface Replay { calls: Array<{ name: string; arguments: Record<string, unknown> }>; reply: string }
/** `careless`: a plausible wrong trajectory that MUST fail (proves the scenario's trap bites). */
interface Gold extends Replay { careless?: Replay }
interface ScenarioFile { accepted: unknown[]; gold: Record<string, Gold> }

const out = (s: string): void => { process.stdout.write(`${s}\n`); };

async function gateOne(env: EnvironmentSpec, runtime: SandboxRuntime, worldId: string, s: SandboxScenario, gold: Gold): Promise<string[]> {
  const reasons: string[] = [];
  const goldRun = await runtime.startRun(worldId, env, s, 0);
  try {
    for (const c of gold.calls) {
      const rec = await goldRun.callTool(c.name, c.arguments);
      out(`   gold ${c.name}(${JSON.stringify(c.arguments)}) -> ${rec.error ? `ERROR ${rec.error}` : JSON.stringify(rec.result).slice(0, 160)}`);
      if (rec.error) reasons.push(`gold call ${c.name} errored: ${rec.error}`);
    }
    const g = await gradeTrial({ env, scenario: s, run: goldRun, transcript: [{ role: "user", content: s.persona.goal }, { role: "assistant", content: gold.reply }] }, { judge: null });
    const failed = g.checks.filter((c) => !c.passed);
    out(`   gold: passed=${g.passed}${failed.length ? ` failed=[${failed.map((c) => `${c.id}: ${c.detail}`).join(" | ")}]` : ""}`);
    if (!g.passed) reasons.push("gold replay does not pass");
  } finally {
    await goldRun.dispose();
  }
  if (gold.careless) {
    const bad = await runtime.startRun(worldId, env, s, 2);
    try {
      for (const c of gold.careless.calls) await bad.callTool(c.name, c.arguments);
      const g = await gradeTrial({ env, scenario: s, run: bad, transcript: [{ role: "assistant", content: gold.careless.reply }] }, { judge: null });
      out(`   careless replay: passed=${g.passed} failed=[${g.checks.filter((c) => !c.passed).map((c) => c.id).join(", ")}]`);
      if (g.passed) reasons.push("careless replay passes");
    } finally {
      await bad.dispose();
    }
  }
  const nullRun = await runtime.startRun(worldId, env, s, 1);
  try {
    const g = await gradeTrial({ env, scenario: s, run: nullRun, transcript: [] }, { judge: null });
    const failedState = g.checks.filter((c) => !c.passed && c.kind === "state").map((c) => c.id);
    out(`   untouched seed: passed=${g.passed} failed=[${g.checks.filter((c) => !c.passed).map((c) => c.id).join(", ")}]`);
    if (g.passed) reasons.push("untouched seed passes");
    if (failedState.length === 0) reasons.push("untouched seed fails no state assertion (only outputs/trajectory)");
  } finally {
    await nullRun.dispose();
  }
  return reasons;
}

async function main(): Promise<void> {
  if (process.env.SANDBOX_LIVE !== "1") { out("set SANDBOX_LIVE=1 to run"); return; }
  const file = JSON.parse(readFileSync(resolve(ROOT, "data/envs/cs-agents-airline/scenarios.json"), "utf8")) as ScenarioFile;
  const scenarios = file.accepted.map((s) => SandboxScenario.parse(s));
  const { spec: env } = await buildCsAgentsAirline();
  const runtime = createNeonSandboxRuntime({ branchTtlHours: 1 });
  const { worldId } = await runtime.prepare(env, `csval_${Date.now().toString(36)}`);
  let bad = 0;
  try {
    for (const s of scenarios) {
      out(`scenario ${s.id}`);
      const gold = file.gold[s.id];
      const reasons = gold ? await gateOne(env, runtime, worldId, s, gold) : ["no gold sequence"];
      out(`   => ${reasons.length ? `REJECT: ${reasons.join("; ")}` : "ACCEPT"}${s.oracleValidated ? "" : " (oracleValidated=false in file)"}`);
      if (reasons.length) bad++;
    }
  } finally {
    await runtime.teardown(worldId);
  }
  out(bad ? `${bad} scenario(s) rejected` : `all ${scenarios.length} scenarios accepted`);
  if (bad) process.exit(1);
}

main().catch((e: unknown) => {
  process.stderr.write(`failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
