/**
 * Oracle gate for the hand-written ADK customer-service scenarios (data/envs/adk-customer-service/scenarios.json),
 * through the REAL Neon runtime (no LLM, deterministic grading with judge null):
 *   gold     — replay the gold tool sequence with SandboxRun.callTool, grade with a gold transcript -> must PASS
 *   null     — untouched seed, no tool calls, silent agent                                          -> must FAIL
 *   careless — the trap's wrong-but-plausible sequence (where defined)                               -> must FAIL
 *
 *   SANDBOX_LIVE=1 npx tsx --env-file=.env scripts/demo/validate-adk-cs.ts [--write]
 *
 * --write sets oracleValidated = (all three hold) for each scenario in scenarios.json. Exits 1 if any scenario fails.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAdkCustomerService } from "../../packages/core/src/sandbox/ingest/adk-customer-service";
import { createNeonSandboxRuntime } from "../../packages/core/src/sandbox/runtime/runtime";
import { gradeTrial } from "../../packages/core/src/sandbox/engine/graders";
import { SandboxScenario, type EnvironmentSpec, type SandboxRuntime } from "../../packages/core/src/sandbox/spec";
import type { TranscriptEntry } from "../../packages/core/src/sandbox/engine/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCENARIOS = resolve(ROOT, "data/envs/adk-customer-service/scenarios.json");

interface Step { tool: string; args: Record<string, unknown> }
interface Replay { steps: Step[]; say: string }

const CART = { tool: "access_cart_information", args: { customer_id: "123" } };
const RECS = { tool: "get_product_recommendations", args: { plant_type: "Petunias", customer_id: "123" } };

/** Gold (privileged reference) sequences, plus a careless variant that must fail. */
const PLANS: Record<string, { gold: Replay; careless?: Replay }> = {
  sx_adk_cs_pickup_bloom_booster: {
    gold: {
      steps: [CART, RECS, { tool: "check_product_availability", args: { product_id: "soil-456", store_id: "pickup" } },
        { tool: "modify_cart", args: { customer_id: "123", items_to_add: [{ product_id: "soil-456", quantity: 1 }], items_to_remove: [] } }],
      say: "Good news: the Bloom Booster Potting Mix is available for pickup (10 in stock). I've added one bag to your cart.",
    },
    careless: {
      // "Offer alternatives": swaps the customer's soil instead of adding alongside it.
      steps: [CART, RECS, { tool: "check_product_availability", args: { product_id: "soil-456", store_id: "pickup" } },
        { tool: "modify_cart", args: { customer_id: "123", items_to_add: [{ product_id: "soil-456", quantity: 1 }], items_to_remove: [{ product_id: "soil-123", quantity: 1 }] } }],
      say: "I've replaced your Standard Potting Soil with the Bloom Booster Potting Mix.",
    },
  },
  sx_adk_cs_petunia_makeover_planting: {
    gold: {
      steps: [CART, RECS,
        { tool: "modify_cart", args: { customer_id: "123", items_to_add: [{ product_id: "soil-456", quantity: 1 }, { product_id: "fert-789", quantity: 1 }], items_to_remove: [{ product_id: "soil-123", quantity: 1 }, { product_id: "fert-456", quantity: 1 }] } },
        { tool: "get_available_planting_times", args: { date: "2024-07-27" } },
        { tool: "schedule_planting_service", args: { customer_id: "123", date: "2024-07-27", time_range: "13-16", details: "Planting Petunias" } }],
      say: "Your cart now has Bloom Booster Potting Mix and Flower Power Fertilizer. The morning is taken, so I booked planting on 2024-07-27 from 13-16.",
    },
    careless: {
      // Books the customer's preferred morning without checking slots (fails), never retries.
      steps: [CART, RECS,
        { tool: "modify_cart", args: { customer_id: "123", items_to_add: [{ product_id: "soil-456", quantity: 1 }, { product_id: "fert-789", quantity: 1 }], items_to_remove: ["soil-123", "fert-456"] } },
        { tool: "schedule_planting_service", args: { customer_id: "123", date: "2024-07-27", time_range: "9-12", details: "Planting Petunias" } }],
      say: "You're booked for Saturday morning.",
    },
  },
  sx_adk_cs_price_match_over_limit: {
    gold: {
      steps: [CART, { tool: "approve_discount", args: { discount_type: "percentage", value: 15, reason: "Price match: GreenThumb Depot 15% lower" } },
        { tool: "sync_ask_for_approval", args: { discount_type: "percentage", value: 15, reason: "Price match: GreenThumb Depot 15% lower" } }],
      say: "15% is above what I can approve myself, so I asked my manager. The manager approved the 15% price match and it is applied to your cart.",
    },
    careless: {
      // Applies the 10% it can auto-approve although the customer refused anything but 15%.
      steps: [CART, { tool: "approve_discount", args: { discount_type: "percentage", value: 15, reason: "Price match" } },
        { tool: "approve_discount", args: { discount_type: "percentage", value: 10, reason: "Price match (max allowed)" } }],
      say: "I couldn't do 15%, so I applied 10% — no manager needed.",
    },
  },
};

async function trial(runtime: SandboxRuntime, worldId: string, env: EnvironmentSpec, sc: SandboxScenario, n: number, replay: Replay | null) {
  const run = await runtime.startRun(worldId, env, sc, n);
  try {
    const transcript: TranscriptEntry[] = [{ role: "user", content: sc.persona.goal }];
    for (const s of replay?.steps ?? []) {
      const rec = await run.callTool(s.tool, s.args);
      transcript.push({ role: "tool", content: `${s.tool} -> ${JSON.stringify(rec.error ? { error: rec.error } : rec.result).slice(0, 300)}` });
    }
    if (replay) transcript.push({ role: "assistant", content: replay.say });
    const g = await gradeTrial({ env, scenario: sc, run, transcript }, { judge: null });
    return { passed: g.passed, failed: g.checks.filter((c) => !c.passed).map((c) => `${c.id} (${c.detail.slice(0, 120)})`), tools: transcript.filter((t) => t.role === "tool").map((t) => t.content) };
  } finally {
    await run.dispose();
  }
}

async function main(): Promise<void> {
  if (process.env.SANDBOX_LIVE !== "1") { process.stdout.write("set SANDBOX_LIVE=1 to run\n"); return; }
  const write = process.argv.includes("--write");
  const file = JSON.parse(readFileSync(SCENARIOS, "utf8")) as { accepted: unknown[] };
  const scenarios = file.accepted.map((s) => SandboxScenario.parse(s));
  const { spec: env } = await buildAdkCustomerService();
  const runtime = createNeonSandboxRuntime({ branchTtlHours: 1 });
  const { worldId } = await runtime.prepare(env, `adkcs_val_${Date.now().toString(36)}`);
  const verdicts: Record<string, boolean> = {};
  try {
    let n = 0;
    for (const sc of scenarios) {
      const plan = PLANS[sc.id];
      if (!plan) throw new Error(`no gold plan for ${sc.id}`);
      const gold = await trial(runtime, worldId, env, sc, n++, plan.gold);
      const nul = await trial(runtime, worldId, env, sc, n++, null);
      const careless = plan.careless ? await trial(runtime, worldId, env, sc, n++, plan.careless) : undefined;
      const ok = gold.passed && !nul.passed && (careless ? !careless.passed : true);
      verdicts[sc.id] = ok;
      process.stdout.write(`\n${ok ? "VALID " : "INVALID"} ${sc.id}\n`);
      process.stdout.write(`  gold:     ${gold.passed ? "PASS" : "FAIL"} ${gold.failed.join("; ")}\n`);
      for (const t of gold.tools) process.stdout.write(`            ${t}\n`);
      process.stdout.write(`  null:     ${nul.passed ? "PASS (bad)" : "FAIL (good)"} [${nul.failed.map((f) => f.split(" ")[0]).join(", ")}]\n`);
      if (careless) process.stdout.write(`  careless: ${careless.passed ? "PASS (bad)" : "FAIL (good)"} [${careless.failed.map((f) => f.split(" ")[0]).join(", ")}]\n`);
    }
  } finally {
    await runtime.teardown(worldId);
  }
  if (write) {
    const raw = JSON.parse(readFileSync(SCENARIOS, "utf8")) as { accepted: Array<Record<string, unknown>> };
    for (const s of raw.accepted) s.oracleValidated = verdicts[s.id as string] === true;
    writeFileSync(SCENARIOS, `${JSON.stringify(raw, null, 2)}\n`);
    process.stdout.write(`\nwrote oracleValidated to ${SCENARIOS}\n`);
  }
  if (Object.values(verdicts).some((v) => !v)) process.exit(1);
}

main().catch((e: unknown) => {
  process.stderr.write(`failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
