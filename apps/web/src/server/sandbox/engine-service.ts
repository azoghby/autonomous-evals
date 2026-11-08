/**
 * Engine-backed SandboxService: environments, suites and runs live in Postgres; generation, gating and trials run
 * in durable workflows (executor). Every read/write is scoped to the owner; foreign ids behave like missing ones.
 */
import { randomUUID } from "node:crypto";
import type { IntegrationMode, SandboxScenario } from "@ae/core/sandbox/spec";
import { listPrebuiltEnvs } from "@ae/core/sandbox/ingest/prebuilt";
import { PLANS, checkEnvironmentAllowance, checkTrialAllowance, usageWindowStart, type PlanId } from "@ae/core/pricing/plans";
import { GATEWAY_TARGET_MODELS, GATEWAY_TARGET_URL, SAMPLE_RUN_ID, type DraftScenario, type SandboxDraft, type SandboxIntakeInput, type SandboxRunReport, type ScenarioReviewInput } from "@/components/sandbox/contract";
import type { SandboxService } from "../sandbox-service";
import { buildCustom, buildFromIntake, buildPrebuilt, type BuiltEnvironment, type CustomWorld } from "./env-build";
import { runScenarios, suiteScenarios, type RunListItem, type RunRow, type SandboxStore } from "./store";
import { SandboxInputError } from "./target";
import { draftView, environmentSummary, runReportView } from "./views";

/** Starts the durable work; returns the workflow run id (null when the executor has none, e.g. inline). */
export interface SandboxExecutor {
  startSuite(suiteId: string): Promise<string | null>;
  startRun(runId: string): Promise<string | null>;
  /** Copilot: generate + gate one scenario from a customer request on a suite seeded with a run's scenarios. */
  startBriefScenario?(suiteId: string, req: BriefScenarioRequest): Promise<string | null>;
}

export interface RunTarget {
  mode: IntegrationMode["mode"];
  /** True when the target is our hosted AI Gateway agent (model + prompt can be changed by the copilot). */
  hosted: boolean;
  model?: string;
  systemPrompt?: string;
}

export interface BriefScenarioRequest { brief: string; category: SandboxScenario["category"]; workflowId?: string }

/** What the copilot may change when it derives a new suite from a finished run. */
export interface SeedSuiteOptions {
  /** Hosted target only: swap the model and/or system prompt (creates a sibling environment). */
  target?: { model?: string; systemPrompt?: string };
  /** Add one generated scenario (runs the gates; the suite is "generating" until they finish). */
  brief?: BriefScenarioRequest;
  /** Drop these scenarios from the new suite. */
  removeScenarioIds?: string[];
}

export const MAX_RUN_K = 10;
export const MAX_RUN_SCENARIOS = 12;
export const MAX_ACTIVE_SUITES = 2;
export const MAX_ACTIVE_RUNS = 2;

const usdToMicro = (raw: string | undefined, fallbackUsd: number, maxUsd: number): number => {
  const n = Number(raw);
  const usd = Number.isFinite(n) && n > 0 ? Math.min(n, maxUsd) : fallbackUsd;
  return Math.round(usd * 1_000_000);
};
/** Per-run cap on our spend (simulator, judge, attribution, AI Gateway target tokens). SANDBOX_RUN_BUDGET_USD, default $3. */
export const runBudgetMicroUsd = (env: Record<string, string | undefined> = process.env) => usdToMicro(env.SANDBOX_RUN_BUDGET_USD, 3, 25);
/** Per-suite cap on generation + gating spend. SANDBOX_SUITE_BUDGET_USD, default $1.50. */
export const suiteBudgetMicroUsd = (env: Record<string, string | undefined> = process.env) => usdToMicro(env.SANDBOX_SUITE_BUDGET_USD, 1.5, 10);

export interface EngineServiceDeps {
  store: SandboxStore;
  executor: SandboxExecutor;
  /** SAMPLE_RUN_ID report (fixture data, labelled sample). */
  sampleReport(): Promise<SandboxRunReport | null>;
  runBudgetMicroUsd?: number;
  suiteBudgetMicroUsd?: number;
  /** Rejects private/non-HTTPS target URLs (SSRF). Returns a reason or null. */
  checkTarget(integration: IntegrationMode): Promise<{ field: string; reason: string } | null>;
  /**
   * The owner's effective billing plan (packages/core/src/pricing/plans.ts). When provided, plan limits are enforced:
   * environment count, trials per calendar month (free: hard stop; paid: overage allowed) and, for plans with a
   * monthly model-spend cap (Developer: $2), run/suite budgets are shrunk to what is left and refused at $0.
   * Omitted = no plan enforcement (bare unit tests, fixtures).
   */
  planFor?(ownerId: string): Promise<PlanId>;
  now?(): Date;
}

export interface EnvironmentInput {
  name: string;
  domain?: string;
  prebuilt?: string;
  world?: Omit<CustomWorld, "name" | "domain">;
  integration: IntegrationMode;
}
export interface EnvironmentView {
  environmentId: string;
  name: string;
  domain: string;
  source: "prebuilt" | "custom";
  prebuiltId: string | null;
  tools: number;
  tables: string[];
  policies: number;
  workflows: Array<{ id: string; name: string }>;
  warnings: string[];
  summary: ReturnType<typeof environmentSummary>;
}

export type StartRunResult = { ok: true; runId: string } | { ok: false; status: 402 | 404 | 409 | 429; error: string };

export interface EngineSandboxService extends SandboxService {
  readonly kind: "engine";
  createEnvironment(ownerId: string, input: EnvironmentInput): Promise<EnvironmentView>;
  generateSuite(ownerId: string, environmentId: string): Promise<SandboxDraft | null>;
  startRun(ownerId: string, draftId: string, opts: { k: number; scenarioIds?: string[]; validatedOnly?: boolean }): Promise<StartRunResult>;
  prebuiltEnvironments(): Array<{ id: string; name: string; domain: string }>;
  /** What a run tested against: hosted model / system prompt when the target is a tool-loop agent. Null when not the owner's. */
  getRunTarget(ownerId: string, runId: string): Promise<RunTarget | null>;
  /** Owner's most recent runs (dashboard). */
  listRuns(ownerId: string, limit?: number): Promise<RunListItem[]>;
  /**
   * Copilot: a new suite holding a finished run's scenarios (gate results carried over), optionally on a sibling
   * environment with a different hosted model / system prompt, minus removed scenarios, plus one generated scenario.
   * Null when the run is not the owner's. Plan limits (environments, spend, concurrency) apply as for any suite.
   */
  seedSuiteFromRun(ownerId: string, runId: string, opts: SeedSuiteOptions): Promise<SandboxDraft | null>;
}

export function createEngineSandboxService(deps: EngineServiceDeps): EngineSandboxService {
  const { store, executor } = deps;
  const runCap = deps.runBudgetMicroUsd ?? runBudgetMicroUsd();
  const suiteCap = deps.suiteBudgetMicroUsd ?? suiteBudgetMicroUsd();

  /**
   * Remaining monthly model-spend allowance for capped plans (micro-USD), or null when the plan has no cap. Budget
   * already reserved by unfinished suites/runs counts as spent, so parallel starts cannot each claim the full headroom.
   */
  async function spendHeadroom(s: SandboxStore, ownerId: string, plan: PlanId): Promise<number | null> {
    const cap = PLANS[plan].limits.monthlyModelSpendCapMicroUsd;
    if (cap == null) return null;
    const used = await s.usageSince(ownerId, usageWindowStart(deps.now?.() ?? new Date()));
    return Math.max(0, cap - used.costMicroUsd - (used.reservedMicroUsd ?? 0));
  }

  /** Plan checks + the insert they guard run under the owner's advisory lock (one transaction) when the store has one. */
  const underOwnerLock = <T>(ownerId: string, fn: (s: SandboxStore) => Promise<T>): Promise<T> =>
    store.withOwnerLock ? store.withOwnerLock(ownerId, fn) : fn(store);

  const SPEND_CAP_REACHED = (plan: PlanId) =>
    `The ${PLANS[plan].name} plan's monthly model budget is used up. It resets on the 1st (UTC), or upgrade to Pro at /pricing.`;

  async function guardEnvironmentLimit(ownerId: string) {
    if (!deps.planFor) return;
    const plan = await deps.planFor(ownerId);
    const allowed = checkEnvironmentAllowance(plan, await store.countEnvironments(ownerId));
    if (!allowed.ok) throw new SandboxInputError(`${allowed.reason} See /pricing.`, 402);
  }

  async function guardTarget(integration: IntegrationMode) {
    const rejected = await deps.checkTarget(integration);
    if (rejected) throw new SandboxInputError(`Target URL rejected: ${rejected.reason}`, 422, `integration.${rejected.field}`);
  }

  async function saveEnvironment(ownerId: string, built: BuiltEnvironment) {
    const id = `env_${randomUUID()}`;
    return store.insertEnvironment({ id, ownerId, name: built.spec.name, domain: built.spec.domain, source: built.source, prebuiltId: built.prebuiltId, spec: built.spec, warnings: built.warnings });
  }

  async function startSuite(ownerId: string, environmentId: string, seed?: { scenarios: DraftScenario[]; brief: BriefScenarioRequest }) {
    const plan = deps.planFor ? await deps.planFor(ownerId) : null;
    const suite = await underOwnerLock(ownerId, async (s) => {
      const active = await s.countActive(ownerId);
      if (active.suites >= MAX_ACTIVE_SUITES) throw new SandboxInputError(`You already have ${active.suites} suites generating. Wait for one to finish.`, 429);
      let budgetMicroUsd = suiteCap;
      if (plan) {
        const headroom = await spendHeadroom(s, ownerId, plan);
        if (headroom !== null && headroom <= 0) throw new SandboxInputError(SPEND_CAP_REACHED(plan), 402);
        if (headroom !== null) budgetMicroUsd = Math.min(budgetMicroUsd, headroom);
      }
      return s.insertSuite({ id: `drf_${randomUUID()}`, environmentId, ownerId, status: "generating", budgetMicroUsd, ...(seed ? { scenarios: seed.scenarios } : {}) });
    });
    try {
      const wf = seed ? await executor.startBriefScenario!(suite.id, seed.brief) : await executor.startSuite(suite.id);
      if (wf) await store.updateSuite(suite.id, { workflowRunId: wf });
      return { ...suite, workflowRunId: wf };
    } catch (e) {
      await store.updateSuite(suite.id, { status: "failed", error: "Could not start suite generation. Try again." });
      throw e;
    }
  }

  /** Run scenarios as reviewable drafts, keeping the gate verdicts the run recorded. */
  function draftsFromRun(run: Awaited<ReturnType<SandboxStore["getRun"]>> & object): DraftScenario[] {
    const gates = new Map((run.gates as Array<{ scenarioId: string; validated: boolean; reasons: string[] }> | null ?? []).map((g) => [g.scenarioId, g]));
    return runScenarios(run).map((scenario) => {
      const g = gates.get(scenario.id);
      return { scenario, decision: "accepted", edited: false, validated: g?.validated ?? scenario.oracleValidated, gateReasons: g?.reasons ?? [] };
    });
  }

  async function targetEnvironment(ownerId: string, envRow: NonNullable<Awaited<ReturnType<SandboxStore["getEnvironment"]>>>, target: SeedSuiteOptions["target"]) {
    if (!target || (!target.model && !target.systemPrompt)) return envRow;
    const spec = envRow.spec as BuiltEnvironment["spec"];
    const integration = spec.integration;
    if (integration.mode !== "tool_loop") throw new SandboxInputError("Only hosted or endpoint (tool loop) agents can change model or prompt here.", 422, "integration");
    const hosted = integration.endpointUrl === GATEWAY_TARGET_URL;
    if (target.model && hosted && !(GATEWAY_TARGET_MODELS as readonly string[]).includes(target.model)) {
      throw new SandboxInputError(`Hosted model must be one of: ${GATEWAY_TARGET_MODELS.join(", ")}.`, 422, "integration.model");
    }
    const next: IntegrationMode = { ...integration, ...(target.model ? { model: target.model } : {}), ...(target.systemPrompt ? { systemPrompt: target.systemPrompt.slice(0, 50_000) } : {}) };
    await guardTarget(next);
    await guardEnvironmentLimit(ownerId);
    const label = [target.model, target.systemPrompt ? "new prompt" : ""].filter(Boolean).join(", ");
    return saveEnvironment(ownerId, { spec: { ...spec, integration: next, name: `${spec.name.replace(/\s*\([^)]*\)\s*$/, "")} (${label})`.slice(0, 200) }, source: envRow.source as BuiltEnvironment["source"], prebuiltId: envRow.prebuiltId, warnings: (envRow.warnings as string[] | null) ?? [] });
  }

  const service: EngineSandboxService = {
    kind: "engine",

    async getRunTarget(ownerId, runId) {
      const run = await store.getRun(ownerId, runId);
      const env = run ? await store.getEnvironment(ownerId, run.environmentId) : null;
      if (!env) return null;
      const integration = (env.spec as BuiltEnvironment["spec"]).integration;
      if (integration.mode !== "tool_loop") return { mode: integration.mode, hosted: false };
      return { mode: integration.mode, hosted: integration.endpointUrl === GATEWAY_TARGET_URL, model: integration.model, systemPrompt: integration.systemPrompt };
    },

    listRuns: (ownerId, limit = 20) => store.listRuns(ownerId, Math.min(50, Math.max(1, limit))),

    async seedSuiteFromRun(ownerId, runId, opts) {
      const run = await store.getRun(ownerId, runId);
      if (!run) return null;
      const base = await store.getEnvironment(ownerId, run.environmentId);
      if (!base) return null;
      const envRow = await targetEnvironment(ownerId, base, opts.target);
      const removed = new Set(opts.removeScenarioIds ?? []);
      const scenarios = draftsFromRun(run).filter((d) => !removed.has(d.scenario.id));
      if (!opts.brief) {
        if (scenarios.length === 0) throw new SandboxInputError("That would leave no scenarios to run.", 409);
        const suite = await store.insertSuite({ id: `drf_${randomUUID()}`, environmentId: envRow.id, ownerId, status: "ready", scenarios, budgetMicroUsd: 0 });
        return draftView(suite, envRow);
      }
      if (!executor.startBriefScenario) throw new SandboxInputError("Adding scenarios is not available here.", 409);
      const suite = await startSuite(ownerId, envRow.id, { scenarios, brief: opts.brief });
      return draftView(suite, envRow);
    },

    prebuiltEnvironments: () => listPrebuiltEnvs().map(({ id, name, domain }) => ({ id, name, domain })),

    async createEnvironment(ownerId, input) {
      await guardTarget(input.integration);
      await guardEnvironmentLimit(ownerId);
      const built = input.prebuilt
        ? await buildPrebuilt(input.prebuilt, input.integration)
        : input.world
          ? await buildCustom({ ...input.world, name: input.name, domain: input.domain ?? "" }, input.integration)
          : (() => { throw new SandboxInputError("Provide tools (openapi, functions or mcpTools) or a prebuilt environment.", 422, "openapi"); })();
      const spec = { ...built.spec, name: input.name.slice(0, 200) };
      const row = await saveEnvironment(ownerId, { ...built, spec });
      return {
        environmentId: row.id, name: row.name, domain: row.domain, source: built.source, prebuiltId: built.prebuiltId,
        tools: spec.tools.length, tables: spec.state.reportTables, policies: spec.policies.length,
        workflows: spec.workflows.map((w) => ({ id: w.id, name: w.name })), warnings: built.warnings, summary: environmentSummary(spec),
      };
    },

    async generateSuite(ownerId, environmentId) {
      const envRow = await store.getEnvironment(ownerId, environmentId);
      if (!envRow) return null;
      const suite = await startSuite(ownerId, envRow.id);
      return draftView(suite, envRow);
    },

    async createDraft(ownerId, input: SandboxIntakeInput) {
      await guardTarget(input.integration);
      await guardEnvironmentLimit(ownerId);
      const built = await buildFromIntake(input);
      const envRow = await saveEnvironment(ownerId, built);
      const suite = await startSuite(ownerId, envRow.id);
      return draftView(suite, envRow);
    },

    async getDraft(ownerId, draftId) {
      const suite = await store.getSuite(ownerId, draftId);
      if (!suite) return null;
      const envRow = await store.getEnvironment(ownerId, suite.environmentId);
      return envRow ? draftView(suite, envRow) : null;
    },

    async reviewScenario(ownerId, draftId, scenarioId, review: ScenarioReviewInput) {
      const suite = await store.getSuite(ownerId, draftId);
      if (!suite || suite.status !== "ready") return null;
      const current = suiteScenarios(suite);
      if (!current.some((d) => d.scenario.id === scenarioId)) return null;
      const scenarios = current.map((d) => {
        if (d.scenario.id !== scenarioId) return d;
        const e = review.edits;
        const edited = !!(e && (e.title || e.personaGoal));
        const scenario = edited ? { ...d.scenario, title: e?.title ?? d.scenario.title, persona: { ...d.scenario.persona, goal: e?.personaGoal ?? d.scenario.persona.goal } } : d.scenario;
        return { ...d, scenario, decision: review.decision, edited: d.edited || edited };
      });
      await store.updateSuite(draftId, { scenarios });
      const envRow = await store.getEnvironment(ownerId, suite.environmentId);
      return envRow ? draftView({ ...suite, scenarios }, envRow) : null;
    },

    async startRun(ownerId, draftId, opts) {
      const suite = await store.getSuite(ownerId, draftId);
      if (!suite) return { ok: false, status: 404, error: "Draft not found" };
      if (suite.status !== "ready") return { ok: false, status: 409, error: suite.status === "failed" ? `Suite generation failed: ${suite.error ?? "unknown error"}` : "The suite is still being generated. Try again when it is ready." };
      const all = suiteScenarios(suite);
      const chosen = opts.scenarioIds?.length
        ? all.filter((d) => opts.scenarioIds!.includes(d.scenario.id))
        : opts.validatedOnly ? all.filter((d) => d.validated) : all.filter((d) => d.decision === "accepted");
      if (opts.scenarioIds?.length && chosen.length !== new Set(opts.scenarioIds).size) return { ok: false, status: 409, error: "Unknown scenario id in scenarioIds" };
      if (chosen.length === 0) return { ok: false, status: 409, error: opts.validatedOnly ? "No scenario passed validation; pass scenarioIds explicitly to run unvalidated ones" : "Accept at least one scenario before running" };
      if (chosen.length > MAX_RUN_SCENARIOS) return { ok: false, status: 409, error: `At most ${MAX_RUN_SCENARIOS} scenarios per run` };
      const k = Math.min(MAX_RUN_K, Math.max(1, Math.floor(opts.k)));
      const plan = deps.planFor ? await deps.planFor(ownerId) : null;
      const maxActiveRuns = plan ? PLANS[plan].limits.concurrentRuns : MAX_ACTIVE_RUNS;
      const envRow = await store.getEnvironment(ownerId, suite.environmentId);
      if (!envRow) return { ok: false, status: 404, error: "Draft not found" };
      const scenarios = chosen.map((d) => d.scenario);
      const reserved = await underOwnerLock(ownerId, async (s): Promise<StartRunResult | RunRow> => {
        const active = await s.countActive(ownerId);
        if (active.runs >= maxActiveRuns) return { ok: false, status: 429, error: `You already have ${active.runs} runs in progress. Wait for one to finish.` };
        let budgetMicroUsd = runCap;
        if (plan) {
          const used = await s.usageSince(ownerId, usageWindowStart(deps.now?.() ?? new Date()));
          const allowance = checkTrialAllowance(plan, used.trials, scenarios.length * k);
          if (!allowance.ok) return { ok: false, status: 402, error: `${allowance.reason} See /pricing.` };
          const headroom = await spendHeadroom(s, ownerId, plan);
          if (headroom !== null && headroom <= 0) return { ok: false, status: 402, error: SPEND_CAP_REACHED(plan) };
          if (headroom !== null) budgetMicroUsd = Math.min(budgetMicroUsd, headroom);
        }
        return s.insertRun({
          id: `run_${randomUUID()}`, ownerId, environmentId: envRow.id, suiteId: suite.id, status: "queued", k, scenarios,
          gates: chosen.map((d) => ({ scenarioId: d.scenario.id, validated: d.validated ?? false, reasons: d.gateReasons ?? [] })),
          budgetMicroUsd, trialsTotal: scenarios.length * k,
        });
      });
      if ("ok" in reserved) return reserved;
      const run = reserved;
      try {
        const wf = await executor.startRun(run.id);
        if (wf) await store.updateRun(run.id, { workflowRunId: wf });
      } catch {
        await store.updateRun(run.id, { status: "failed", error: "Could not start the run workflow. Try again.", errorKind: "retryable", completedAt: new Date() });
        return { ok: false, status: 409, error: "Could not start the run. Try again." };
      }
      return { ok: true, runId: run.id };
    },

    async getRunReport(ownerId, runId) {
      if (runId === SAMPLE_RUN_ID) return deps.sampleReport();
      const run = await store.getRun(ownerId, runId);
      if (!run) return null;
      const envRow = await store.getEnvironment(ownerId, run.environmentId);
      return envRow ? runReportView(run, envRow) : null;
    },
  };
  return service;
}

/** For MCP status: compact progress without transcripts. */
export function runStatusView(report: SandboxRunReport) {
  const done = report.results.length;
  return {
    runId: report.runId, status: report.status, k: report.k,
    scenariosCompleted: done, scenariosTotal: report.scenarios.length,
    trialsCompleted: report.progress?.trialsDone ?? 0, trialsTotal: report.progress?.trialsTotal ?? report.scenarios.length * report.k,
    costUsd: (report.costMicroUsd ?? 0) / 1e6, budgetUsd: (report.budgetMicroUsd ?? 0) / 1e6,
    ...(report.error ? { error: report.error, errorKind: report.errorKind } : {}),
  };
}

