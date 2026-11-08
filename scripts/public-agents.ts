/**
 * Public-agent leaderboard runner.
 *
 *   npx tsx --env-file=.env scripts/public-agents.ts list
 *   npx tsx --env-file=.env scripts/public-agents.ts init                 # create leaderboard tables if missing (idempotent)
 *   npx tsx --env-file=.env scripts/public-agents.ts seed                 # upsert agents from data/public-agents.json
 *   npx tsx --env-file=.env scripts/public-agents.ts add '<json>|@file.json|file.json'
 *   npx tsx --env-file=.env scripts/public-agents.ts run <slug|--all> [--dry-run] [--investigate] [--allow-local] [--budget-usd 2] [--timeout-min 15]
 *     --allow-local: required for kind local_reference agents (http://127.0.0.1 shims of real open-source agents). CLI only, never cron.
 *   npx tsx scripts/public-agents.ts suite                                # (re)freeze data/standard-suite-v1.json
 *
 * Safety: refuses any agent without termsUrl + authorizedNote (or marked inactive). API keys are read from the env var NAMED in
 * authEnvVar and are never stored or printed. --dry-run validates everything and prints the plan: no network, no DB writes.
 * Engine: imports packages/core/src/lite/index.ts when it exists (EvalServices); otherwise exits with a clear message.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Suite } from "../packages/core/src/contracts/index";
import { PublicAgentInput, assertAuthorizedToTest, UnauthorizedAgentError } from "../apps/web/src/server/leaderboard-agents";
import { runPublicAgent, DEFAULT_BUDGET_MICRO_USD, DEFAULT_TIMEOUT_MIN } from "../apps/web/src/server/public-agent-runner";
import { buildStandardSuite } from "../apps/web/src/server/leaderboard-suite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUITE_PATH = resolve(ROOT, "data/standard-suite-v1.json");
const AGENTS_PATH = resolve(ROOT, "data/public-agents.json");
export { DEFAULT_BUDGET_MICRO_USD, DEFAULT_TIMEOUT_MIN, derivedFindings } from "../apps/web/src/server/public-agent-runner";

export interface Cli { cmd: string; target?: string; all: boolean; dryRun: boolean; investigate: boolean; allowLocal: boolean; budgetMicroUsd: number; timeoutMin: number }

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
    cmd, target, all: flag("--all"), dryRun: flag("--dry-run"), investigate: flag("--investigate"), allowLocal: flag("--allow-local"),
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

async function runAgent(row: PublicAgentInput, cli: Cli, suite: Suite): Promise<void> {
  await runPublicAgent(row, { suite, budgetMicroUsd: cli.budgetMicroUsd, timeoutMin: cli.timeoutMin, dryRun: cli.dryRun, investigate: cli.investigate, allowLocal: cli.allowLocal });
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
      // Entries in the JSON file that are not in the DB yet (before `seed`) are usable for --dry-run planning.
      if (cli.dryRun) { const have = new Set(agents.map((a) => a.slug)); agents = [...agents, ...readAgentFile().filter((a) => !have.has(a.slug))]; }
      const picked = cli.all ?agents.filter((a) => a.active !== false) : agents.filter((a) => a.slug === cli.target);
      if (!picked.length) throw new Error(`no agent matches ${cli.target ?? "--all"}`);
      let failures = 0;
      for (const a of picked) {
        try { await runAgent(a, cli, suite); }
        catch (e) { failures += 1; console.error(`[fail] ${a.slug}: ${(e as Error).message}`); }
      }
      return failures ? 1 : 0;
    }
    default:
      console.log("commands: list | init | seed | add <json|@file> | run <slug|--all> [--dry-run] [--investigate] [--allow-local] [--budget-usd N] [--timeout-min N] | suite");
      return cli.cmd === "help" ? 0 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c), (e) => { console.error((e as Error).message); process.exit(1); });
}
