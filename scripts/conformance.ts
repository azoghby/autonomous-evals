/**
 * Runs the EvalServices conformance harness.
 * Usage: npx tsx scripts/conformance.ts [--strict] [--services real|lite] [--skip-branching] [--skip-suite]
 *          [--target-url https://... --target-model <id> [--target-key-env ENV_NAME] [--target-system "<prompt>"]]
 * --services defaults to EVAL_SERVICES when it is "lite", else "real" (Track B).
 * --target-* enables the live runSuite check; the key is read from the named env var and never printed.
 * --strict requires an explicit/effective real selection, HTTPS target URL/model and all checks.
 * Strict is contract evidence only; fixture jobs do not establish hosted app admission.
 * Exits non-zero on any failed check, or if the services module is missing.
 * --services real resolves ctx.jobId against the `jobs` table, so each check gets a fresh internal-fixture
 * draft job (environment "test", customer sandbox-e2e@example.com); --no-fixture-job uses CONFORMANCE_JOB_ID.
 * Typed "pending" errors (Naïve rate limits, async branch deletion) are retried as the Workflow would.
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseConformanceOptions, conformanceJobIds, ConformanceOptionsError } from "./conformance-options";
import { createStrictConformanceServices } from "./naive-conformance-gate";
import { ensureFixtureJob, withPendingRetry } from "./real-services-lib";
import { runConformance, summarize } from "../packages/core/src/contracts/conformance";
import type { EvalServices, ServiceContext } from "../packages/core/src/contracts/services";

async function loadServices(kind: string): Promise<EvalServices> {
  if (kind === "lite") {
    const mod = await import("../packages/core/src/lite/index");
    return mod.liteServices();
  }
  const modPath = "../packages/core/src/integration/eval-services";
  try {
    const mod = (await import(modPath)) as { evalServices?: EvalServices };
    if (!mod.evalServices) { console.error(`${modPath} loaded but does not export \`evalServices\`.`); process.exit(2); }
    return mod.evalServices;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(err.message ?? "")) {
      console.error(`Real services module not found: packages/core/src/integration/eval-services.ts (exporting \`evalServices\`). Nothing to check yet.`);
      process.exit(2);
    }
    console.error("Failed to load real services.");
    process.exit(2);
  }
}

/** Wraps every method so ctx.recordCost calls are also summed here (spend report only). */
function withSpendMeter(services: EvalServices): { services: EvalServices; spent: () => number } {
  let total = 0;
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(services)) {
    if (typeof fn !== "function") continue;
    out[name] = (...args: unknown[]) => {
      const [first, ...rest] = args;
      const ctx = first as ServiceContext | undefined;
      if (ctx && typeof ctx === "object" && typeof ctx.recordCost === "function") {
        const metered: ServiceContext = { ...ctx, async recordCost(e) { total += e.microUsd; await ctx.recordCost(e); } };
        return (fn as (...a: unknown[]) => unknown).apply(services, [metered, ...rest]);
      }
      return (fn as (...a: unknown[]) => unknown).apply(services, args);
    };
  }
  return { services: out as unknown as EvalServices, spent: () => total };
}

export async function main() {
  const options = parseConformanceOptions(process.argv.slice(2));
  const kind = options.services;
  const real = kind === "real";
  const fixtureJobs = options.fixtureJobs;
  const loaded = await loadServices(kind);
  const gate = options.strict ? createStrictConformanceServices(loaded) : undefined;
  const selected = gate?.services ?? loaded;
  const metered = withSpendMeter(real ? withPendingRetry(selected) : selected);
  const targetUrl = options.targetUrl;
  const keyEnv = options.targetKeyEnv;
  const runSuiteTarget = targetUrl ? {
    url: targetUrl,
    model: options.targetModel ?? "anthropic/claude-haiku-5.5",
    apiKey: keyEnv ? process.env[keyEnv] || undefined : undefined,
    systemPrompt: options.targetSystem ?? "Answer from the reference text only. Reference: Refunds are available within 30 days.",
  } : undefined;
  console.log(`services=${kind} strict=${options.strict} target=${runSuiteTarget ? "configured" : "none"}`);
  const observed = await runConformance(metered.services, {
    skipBranching: options.skipBranching, skipSuite: options.skipSuite, runSuiteTarget,
    ...(fixtureJobs ? { jobIdFor: conformanceJobIds(options.strict, () => ensureFixtureJob(randomUUID())) } : {}),
  });
  const checks = (gate ? gate.validate(observed) : observed).map(c => options.strict ? { ...c, message: c.status === "fail" ? "Strict conformance check failed." : c.status === "skip" ? "Check skipped." : "Check passed." } : c);
  const icon = { pass: "PASS", fail: "FAIL", skip: "SKIP" } as const;
  const w = Math.max(...checks.map((c) => `${c.group}: ${c.name}`.length));
  for (const c of checks) console.log(`${icon[c.status]}  ${`${c.group}: ${c.name}`.padEnd(w)}  ${c.message}`);
  const s = summarize(checks);
  console.log(`\n${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped; recorded model spend $${(metered.spent() / 1e6).toFixed(4)}`);
  process.exit(s.failed > 0 ? 1 : 0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof ConformanceOptionsError ? error.message : "Conformance could not complete; no acceptance result was produced."); process.exitCode = 2; });
}
