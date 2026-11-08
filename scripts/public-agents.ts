/**
 * Public-agent leaderboard runner.
 *
 *   npx tsx --env-file=.env scripts/public-agents.ts list
 *   npx tsx --env-file=.env scripts/public-agents.ts init                 # create leaderboard tables if missing (idempotent)
 *   npx tsx --env-file=.env scripts/public-agents.ts seed                 # upsert agents from data/public-agents.json
 *   npx tsx --env-file=.env scripts/public-agents.ts add '<json>|@file.json|file.json'
 *   npx tsx --env-file=.env scripts/public-agents.ts run <slug|--all> [--dry-run] [--investigate] [--budget-usd 2] [--timeout-min 15]
 *   npx tsx scripts/public-agents.ts suite                                # (re)freeze data/standard-suite-v1.json
 *
 * Safety: refuses any agent without termsUrl + authorizedNote (or marked inactive). API keys are read from the env var NAMED in
 * authEnvVar and are never stored or printed. --dry-run validates everything and prints the plan: no network, no DB writes.
 * Engine: imports packages/core/src/lite/index.ts when it exists (EvalServices); otherwise exits with a clear message.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Suite, type Finding } from "../packages/core/src/contracts/index";
import type { EvalServices, ServiceContext } from "../packages/core/src/contracts/services";
import { redTeamById } from "../packages/core/src/redteam/index";
import { PublicAgentInput, assertAuthorizedToTest, UnauthorizedAgentError } from "../apps/web/src/server/leaderboard-agents";
import { SUITE_VERSION, scoreRun, toStoredFindings, percent, type StoredFinding } from "../apps/web/src/server/leaderboard";
import { buildStandardSuite } from "../apps/web/src/server/leaderboard-suite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUITE_PATH = resolve(ROOT, "data/standard-suite-v1.json");
const AGENTS_PATH = resolve(ROOT, "data/public-agents.json");
const LITE_PATH = resolve(ROOT, "packages/core/src/lite/index.ts");
export const DEFAULT_BUDGET_MICRO_USD = 2_000_000;
export const DEFAULT_TIMEOUT_MIN = 15;

export interface Cli { cmd: string; target?: string; all: boolean; dryRun: boolean; investigate: boolean; budgetMicroUsd: number; timeoutMin: number }

/** Pure argv parser (exported for tests). */
export function parseCli(argv: string[]): Cli {
  const [cmd = "help", ...rest] = argv;
  const flag = (n: string) => rest.includes(n);
  const val = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const skip = new Set<number>();
  for (const n of ["--budget-usd", "--timeout-min"]) { const i = rest.indexOf(n); if (i >= 0) skip.add(i + 1); }
  const target = rest.find((a, i) => !a.startsWith("--") && !skip.has(i));
  const usd = Number(val("--budget-usd") ?? NaN);
  const mins = Number(val("--timeout-min") ?? NaN);
  return {
    cmd, target, all: flag("--all"), dryRun: flag("--dry-run"), investigate: flag("--investigate"),
    budgetMicroUsd: Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1_000_000) : DEFAULT_BUDGET_MICRO_USD,
    timeoutMin: Number.isFinite(mins) && mins > 0 ? mins : DEFAULT_TIMEOUT_MIN,
  };
}

export function loadFrozenSuite(): Suite {
  if (!existsSync(SUITE_PATH)) throw new Error(`Missing ${SUITE_PATH}. Run: npx tsx scripts/public-agents.ts suite`);
  return Suite.parse(JSON.parse(readFileSync(SUITE_PATH, "utf8")));
}

function readAgentFile(): PublicAgentInput[] {
  const raw = JSON.parse(readFileSync(AGENTS_PATH, "utf8")) as { agents: unknown[] };
  return raw.agents.map((a) => PublicAgentInput.parse(a));
}

async function resolveEngine(): Promise<EvalServices> {
  if (!existsSync(LITE_PATH)) {
    throw new Error("Eval engine not found (packages/core/src/lite/index.ts). The lite engine has not landed yet; nothing was run. Re-run once it exists (use --dry-run to validate the setup now).");
  }
  const mod = (await import(pathToFileURL(LITE_PATH).href)) as Record<string, unknown>;
  const candidates = [mod.liteEvalServices, mod.evalServices, mod.default,
    typeof mod.liteServices === "function" ? (mod.liteServices as () => unknown)() : undefined,
    typeof mod.createLiteServices === "function" ? (mod.createLiteServices as () => unknown)() : undefined,
    typeof mod.createLiteEvalServices === "function" ? (mod.createLiteEvalServices as () => unknown)() : undefined,
    typeof mod.getLiteEvalServices === "function" ? (mod.getLiteEvalServices as () => unknown)() : undefined];
  const svc = candidates.find((c): c is EvalServices => !!c && typeof (c as EvalServices).runSuite === "function");
  if (!svc) throw new Error(`packages/core/src/lite/index.ts does not export an EvalServices (looked for liteServices(), createLiteServices(), liteEvalServices, evalServices, default, createLiteEvalServices(), getLiteEvalServices()). Exports: ${Object.keys(mod).join(", ")}`);
  return svc;
}

/** Findings from failed scenarios: deterministic, no extra model spend. Severity comes from the red-team library; designed scenarios are medium. */
export function derivedFindings(suite: Suite, results: Array<{ scenarioId: string; passed: boolean; detail: string }>): StoredFinding[] {
  const byId = new Map(suite.scenarios.map((s) => [s.id, s]));
  const failed = results.filter((r) => !r.passed);
  return toStoredFindings(failed.map((r) => {
    const sc = byId.get(r.scenarioId);
    const rt = redTeamById(r.scenarioId);
    return {
      title: sc?.title ?? r.scenarioId, severity: rt?.severity ?? "medium", category: sc?.category ?? "other", scenarioId: r.scenarioId,
      evidence: [{ excerpt: r.detail }],
    };
  }));
}

class BudgetExceeded extends Error { constructor(spent: number, cap: number) { super(`budget exceeded: ${spent} > ${cap} micro-USD`); } }

async function runAgent(row: PublicAgentInput & { id?: string }, cli: Cli, suite: Suite): Promise<void> {
  assertAuthorizedToTest(row);
  const apiKey = row.authEnvVar ? process.env[row.authEnvVar] : undefined;
  const plan = `${row.slug}: ${row.model} @ ${row.endpointUrl} | ${suite.scenarios.length} scenarios | budget $${(cli.budgetMicroUsd / 1e6).toFixed(2)} | key ${row.authEnvVar ? (apiKey ? `from $${row.authEnvVar}` : `MISSING $${row.authEnvVar}`) : "none"}`;
  if (cli.dryRun) { console.log(`[dry-run] ${plan}`); return; }
  if (row.authEnvVar && !apiKey) throw new Error(`env var ${row.authEnvVar} is not set`);
  console.log(`[run] ${plan}`);

  const services = await resolveEngine();
  const { upsertAgent, insertRun } = await import("../apps/web/src/server/leaderboard-db");
  const agent = await upsertAgent(PublicAgentInput.parse(row));

  let spent = 0;
  const ctx: ServiceContext = {
    jobId: randomUUID(), environment: "live", budgetMicroUsd: cli.budgetMicroUsd,
    async recordCost(entry) { spent += entry.microUsd; if (spent > cli.budgetMicroUsd) throw new BudgetExceeded(spent, cli.budgetMicroUsd); },
    async recordProgress(m, msg) { console.log(`  [${row.slug}] ${m}: ${msg.slice(0, 120)}`); },
  };
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${cli.timeoutMin} min`)), cli.timeoutMin * 60_000).unref());
  const target = { url: row.endpointUrl, model: row.model, ...(apiKey ? { apiKey } : {}), systemPrompt: row.systemPrompt ?? "" };
  const run = await Promise.race([services.runSuite(ctx, suite, target), timeout]);

  const score = scoreRun(suite.scenarios, run.results);
  let findings = derivedFindings(suite, run.results);
  if (cli.investigate) {
    try {
      const f: Finding[] = await Promise.race([services.investigate(ctx, suite, [run]), timeout]);
      findings = toStoredFindings(f);
    } catch (e) { console.warn(`  investigate failed, using derived findings: ${(e as Error).message}`); }
  }
  await insertRun({ agentId: agent.id, suiteVersion: SUITE_VERSION, ...score, findings, costMicroUsd: spent });
  console.log(`[done] ${row.slug}: ${score.passed}/${score.total} (${percent(score.passed / Math.max(1, score.total))}), ${findings.length} findings, $${(spent / 1e6).toFixed(3)}`);
}

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  switch (cli.cmd) {
    case "suite": {
      writeFileSync(SUITE_PATH, JSON.stringify(buildStandardSuite(), null, 2) + "\n");
      console.log(`wrote ${SUITE_PATH}`); return 0;
    }
    case "init": {
      const { ensureLeaderboardTables } = await import("../apps/web/src/server/leaderboard-db");
      await ensureLeaderboardTables(); console.log("leaderboard tables ready"); return 0;
    }
    case "seed": {
      const { upsertAgent } = await import("../apps/web/src/server/leaderboard-db");
      for (const a of readAgentFile()) { await upsertAgent(a); console.log(`upserted ${a.slug}`); }
      return 0;
    }
    case "add": {
      if (!cli.target) throw new Error("usage: add '<json>' | add @file.json");
      const t = cli.target.replace(/^@/, "");
      const raw = existsSync(t) ? readFileSync(t, "utf8") : cli.target;
      const input = PublicAgentInput.parse(JSON.parse(raw));
      try { assertAuthorizedToTest(input); } catch (e) { if (e instanceof UnauthorizedAgentError) console.warn(`warning: stored, but it cannot be run yet. ${e.message}`); else throw e; }
      const { upsertAgent } = await import("../apps/web/src/server/leaderboard-db");
      await upsertAgent(input); console.log(`saved ${input.slug}`); return 0;
    }
    case "list": {
      let rows: Array<PublicAgentInput> = [];
      let source = "DB";
      try { const { listAgents } = await import("../apps/web/src/server/leaderboard-db"); rows = (await listAgents()) as unknown as PublicAgentInput[]; }
      catch { rows = readAgentFile(); source = "data/public-agents.json (DB unavailable)"; }
      console.log(`agents from ${source}:`);
      for (const r of rows) {
        let auth = "authorized";
        try { assertAuthorizedToTest(r); } catch (e) { auth = `BLOCKED (${(e as Error).message.split(": ").slice(1).join(": ")})`; }
        console.log(`  ${r.slug.padEnd(24)} ${r.kind.padEnd(11)} ${r.model.padEnd(32)} ${auth}`);
      }
      return 0;
    }
    case "run": {
      if (!cli.all && !cli.target) throw new Error("usage: run <slug|--all> [--dry-run]");
      const suite = loadFrozenSuite();
      let agents: PublicAgentInput[];
      try { const { listAgents } = await import("../apps/web/src/server/leaderboard-db"); agents = (await listAgents()) as unknown as PublicAgentInput[]; if (!agents.length) agents = readAgentFile(); }
      catch { agents = readAgentFile(); }
      const picked = cli.all ? agents.filter((a) => a.active !== false) : agents.filter((a) => a.slug === cli.target);
      if (!picked.length) throw new Error(`no agent matches ${cli.target ?? "--all"}`);
      let failures = 0;
      for (const a of picked) {
        try { await runAgent(a, cli, suite); }
        catch (e) { failures += 1; console.error(`[fail] ${a.slug}: ${(e as Error).message}`); }
      }
      return failures ? 1 : 0;
    }
    default:
      console.log("commands: list | init | seed | add <json|@file> | run <slug|--all> [--dry-run] [--investigate] [--budget-usd N] [--timeout-min N] | suite");
      return cli.cmd === "help" ? 0 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c), (e) => { console.error((e as Error).message); process.exit(1); });
}
