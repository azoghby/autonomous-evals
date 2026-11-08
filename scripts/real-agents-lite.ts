/**
 * Evaluate a REAL open-source agent running on localhost with the Standard Evals LITE engine.
 *
 *   npx tsx --env-file=.env scripts/real-agents-lite.ts --slug cs-agents-demo --port 8765 [--limit 3] [--budget-usd 1.5]
 *       [--name "..."] [--model label] [--out results.json] [--agent-commit sha] [--agent-models "a; b"]
 *
 * The lite engine refuses http/localhost endpoints, so the agent is addressed as https://<slug>.real-agent.test/v1/chat/completions
 * and an injected JsonTransport (the engine's test seam) maps exactly that host onto http://127.0.0.1:<port>. Any other host is refused.
 * No DB writes: this never calls runPublicAgent or leaderboard-db. Secrets are never printed; the gateway key is only used for
 * the judge (via the lite engine) and the credits check.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Finding } from "../packages/core/src/contracts/index";
import type { ServiceContext } from "../packages/core/src/contracts/services";
import { createLiteServices } from "../packages/core/src/lite/index";
import { decodeDetail } from "../packages/core/src/lite/deps";
import type { JsonTransport } from "../packages/core/src/targets/transport";
import { PublicAgentInput, assertAuthorizedToTest } from "../apps/web/src/server/leaderboard-agents";
import { SUITE_VERSION, scoreRun, percent } from "../apps/web/src/server/leaderboard";
import { derivedFindings } from "../apps/web/src/server/public-agent-runner";
import { loadFrozenSuite } from "./public-agents";

const CREDITS_URL = "https://ai-gateway.vercel.sh/v1/credits";
const DEFAULT_BUDGET_USD = 1.5;
const EXCERPT = 400;

export interface RealAgentCli {
  slug: string; port: number; name: string; model: string; budgetMicroUsd: number; limit?: number; out: string;
  agentCommit: string; agentModels: string; termsUrl: string; authorizedNote: string; homepage?: string;
}

const SCRATCH = "/private/tmp/claude-501/-Users-ronitkatikaneni/66543cfa-6695-44c1-a484-ff7de31df425/scratchpad/real-agents";
const CS_NOTE = "MIT-licensed open-source code (openai/openai-cs-agents-demo @ bd7bfca), run by us on our infra (localhost) with our own model key; no third-party endpoint contacted";

/** Pure argv parser (exported for tests). */
export function parseCli(argv: string[]): RealAgentCli {
  const val = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const slug = val("--slug") ?? "cs-agents-demo";
  const usd = Number(val("--budget-usd") ?? DEFAULT_BUDGET_USD);
  const limit = Number(val("--limit") ?? NaN);
  const port = Number(val("--port") ?? 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1-65535");
  const isCs = slug === "cs-agents-demo";
  return {
    slug, port, name: val("--name") ?? (isCs ? "OpenAI CS Agents Demo (airline)" : slug),
    model: val("--model") ?? slug,
    budgetMicroUsd: Math.round((Number.isFinite(usd) && usd > 0 ? usd : DEFAULT_BUDGET_USD) * 1_000_000),
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined,
    out: val("--out") ?? `${SCRATCH}/results-${isCs ? "cs-agents-lite" : slug}.json`,
    agentCommit: val("--agent-commit") ?? (isCs ? "bd7bfca0f5abf50529370814c3e7c88542011925" : "unknown"),
    agentModels: val("--agent-models") ?? (isCs ? "agents: openai/gpt-5-mini (demo: gpt-5.2); guardrails: openai/gpt-4.1-mini (demo: gpt-4.1-mini)" : "unspecified"),
    termsUrl: val("--terms-url") ?? (isCs ? "https://github.com/openai/openai-cs-agents-demo/blob/main/LICENSE" : ""),
    authorizedNote: val("--authorized-note") ?? (isCs ? CS_NOTE : ""),
    homepage: val("--homepage") ?? (isCs ? "https://github.com/openai/openai-cs-agents-demo" : undefined),
  };
}

export const fakeHostFor = (slug: string): string => `${slug}.real-agent.test`;

/** Maps https://<fakeHost>/path onto http://127.0.0.1:<port>/path; refuses every other host/scheme. Exported for tests. */
export function mapEndpoint(endpoint: string, fakeHost: string, port: number): string {
  let u: URL;
  try { u = new URL(endpoint); } catch { throw new Error("transport: invalid endpoint"); }
  if (u.protocol !== "https:" || u.hostname !== fakeHost || u.username || u.password || (u.port && u.port !== "443")) {
    throw new Error(`transport: refused host ${u.hostname || "?"} (only ${fakeHost} is mapped)`);
  }
  return `http://127.0.0.1:${port}${u.pathname}`;
}

export function localhostTransport(fakeHost: string, port: number, timeoutMs = 120_000, fetchImpl: typeof fetch = fetch): JsonTransport {
  return {
    async post(endpoint, body) {
      const target = mapEndpoint(endpoint, fakeHost, port); // throws before any I/O for foreign hosts
      const res = await fetchImpl(target, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`target_http_${res.status}`);
      return res.json();
    },
  };
}

async function gatewayCredits(): Promise<number | null> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(CREDITS_URL, { headers: { authorization: `Bearer ${key}` } });
    const j = (await r.json()) as { total_used?: string | number };
    const n = Number(j.total_used);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

async function shimStats(port: number): Promise<Record<string, unknown> | null> {
  try { return (await (await fetch(`http://127.0.0.1:${port}/stats`)).json()) as Record<string, unknown>; } catch { return null; }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);

class BudgetExceeded extends Error {}

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  const fakeHost = fakeHostFor(cli.slug);
  const row = PublicAgentInput.parse({
    slug: cli.slug, name: cli.name, vendor: "open-source (self-hosted)", kind: "reference",
    endpointUrl: `https://${fakeHost}/v1/chat/completions`, model: cli.model, authEnvVar: null,
    homepage: cli.homepage, termsUrl: cli.termsUrl || undefined, authorizedNote: cli.authorizedNote || undefined, active: true,
  });
  assertAuthorizedToTest(row);

  const fullSuite = loadFrozenSuite();
  const suite = cli.limit ? { ...fullSuite, scenarios: fullSuite.scenarios.slice(0, cli.limit) } : fullSuite;
  const services = createLiteServices({ transport: localhostTransport(fakeHost, cli.port) });

  const health = await shimStats(cli.port);
  if (!health) throw new Error(`no agent shim answering on 127.0.0.1:${cli.port}`);
  const creditsBefore = await gatewayCredits();
  const statsBefore = health;

  let spent = 0;
  const ctx: ServiceContext = {
    jobId: randomUUID(), environment: "test", budgetMicroUsd: cli.budgetMicroUsd,
    async recordCost(entry) { spent += entry.microUsd; if (spent > cli.budgetMicroUsd) throw new BudgetExceeded(`eval spend ${spent} > ${cli.budgetMicroUsd} micro-USD`); },
    async recordProgress(m, msg) { console.log(`  [${cli.slug}] ${m}: ${msg.slice(0, 120)}`); },
  };
  console.log(`[run] ${cli.slug} | ${suite.scenarios.length}/${fullSuite.scenarios.length} scenarios | eval budget $${(cli.budgetMicroUsd / 1e6).toFixed(2)} | agent: ${cli.agentModels}`);

  const t0 = Date.now();
  let run; let runError: string | undefined;
  try {
    run = await services.runSuite(ctx, suite, { url: row.endpointUrl, model: row.model, systemPrompt: "" });
  } catch (e) { runError = (e as Error).message; }
  const wallSeconds = Math.round((Date.now() - t0) / 1000);

  const creditsAfter = await gatewayCredits();
  const statsAfter = await shimStats(cli.port);
  const base = {
    agent: { slug: cli.slug, name: cli.name, commit: cli.agentCommit, license: cli.termsUrl, authorizedNote: cli.authorizedNote },
    agentModels: cli.agentModels, suiteVersion: SUITE_VERSION, scenariosRun: suite.scenarios.length, wallSeconds,
    evalSpendUsd: spent / 1e6, shimStats: statsAfter, shimStatsBefore: statsBefore,
    gatewayCreditsUsedBefore: creditsBefore, gatewayCreditsUsedAfter: creditsAfter,
    gatewayDeltaUsd: creditsBefore != null && creditsAfter != null ? Number((creditsAfter - creditsBefore).toFixed(4)) : null,
  };
  if (!run) {
    writeFileSync(cli.out, JSON.stringify({ ...base, error: runError }, null, 2));
    console.error(`[fail] ${runError}`); return 1;
  }

  const score = scoreRun(suite.scenarios, run.results);
  const byId = new Map(suite.scenarios.map((s) => [s.id, s]));
  const scenarios = run.results.map((r) => {
    const d = decodeDetail(r.detail);
    const s = byId.get(r.scenarioId);
    return {
      id: r.scenarioId, title: s?.title, category: s?.category, passed: r.passed,
      grader: d?.grader, detail: clip(d?.reason ?? r.detail, EXCERPT), failedRules: d?.failedRules,
      transcript: d?.turns.map((t) => `${t.role.toUpperCase()}: ${clip(t.excerpt, EXCERPT)}`),
    };
  });
  const findings = derivedFindings(suite, run.results);
  const out = {
    ...base, passed: score.passed, total: score.total, passRate: percent(score.passed / Math.max(1, score.total)),
    byCategory: score.byCategory, scenarios, findings: findings as Finding[] | unknown[],
  };
  writeFileSync(cli.out, JSON.stringify(out, null, 2));
  console.log(`[done] ${score.passed}/${score.total} (${out.passRate}) | eval spend $${base.evalSpendUsd.toFixed(3)} | gateway delta $${base.gatewayDeltaUsd} | ${wallSeconds}s -> ${cli.out}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c), (e) => { console.error(`[error] ${(e as Error).message}`); process.exit(1); });
}
