/**
 * Engine-backed SandboxService: environments, suites and runs live in Postgres; generation, gating and trials run
 * in durable workflows (executor). Every read/write is scoped to the owner; foreign ids behave like missing ones.
 */
import { randomUUID } from "node:crypto";
import type { IntegrationMode } from "@ae/core/sandbox/spec";
import { listPrebuiltEnvs } from "@ae/core/sandbox/ingest/prebuilt";
import { SAMPLE_RUN_ID, type SandboxDraft, type SandboxIntakeInput, type SandboxRunReport, type ScenarioReviewInput } from "@/components/sandbox/contract";
import type { SandboxService } from "../sandbox-service";
import { buildCustom, buildFromIntake, buildPrebuilt, type BuiltEnvironment, type CustomWorld } from "./env-build";
import { suiteScenarios, type SandboxStore } from "./store";
import { SandboxInputError } from "./target";
import { draftView, environmentSummary, runReportView } from "./views";

/** Starts the durable work; returns the workflow run id (null when the executor has none, e.g. inline). */
export interface SandboxExecutor {
  startSuite(suiteId: string): Promise<string | null>;
  startRun(runId: string): Promise<string | null>;
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

export type StartRunResult = { ok: true; runId: string } | { ok: false; status: 404 | 409 | 429; error: string };

export interface EngineSandboxService extends SandboxService {
  readonly kind: "engine";
  createEnvironment(ownerId: string, input: EnvironmentInput): Promise<EnvironmentView>;
  generateSuite(ownerId: string, environmentId: string): Promise<SandboxDraft | null>;
  startRun(ownerId: string, draftId: string, opts: { k: number; scenarioIds?: string[]; validatedOnly?: boolean }): Promise<StartRunResult>;
  prebuiltEnvironments(): Array<{ id: string; name: string; domain: string }>;
}

export function createEngineSandboxService(deps: EngineServiceDeps): EngineSandboxService {
  const { store, executor } = deps;
  const runCap = deps.runBudgetMicroUsd ?? runBudgetMicroUsd();
  const suiteCap = deps.suiteBudgetMicroUsd ?? suiteBudgetMicroUsd();

  async function guardTarget(integration: IntegrationMode) {
    const rejected = await deps.checkTarget(integration);
    if (rejected) throw new SandboxInputError(`Target URL rejected: ${rejected.reason}`, 422, `integration.${rejected.field}`);
  }

  async function saveEnvironment(ownerId: string, built: BuiltEnvironment) {
    const id = `env_${randomUUID()}`;
    return store.insertEnvironment({ id, ownerId, name: built.spec.name, domain: built.spec.domain, source: built.source, prebuiltId: built.prebuiltId, spec: built.spec, warnings: built.warnings });
  }

  async function startSuite(ownerId: string, environmentId: string) {
    const active = await store.countActive(ownerId);
    if (active.suites >= MAX_ACTIVE_SUITES) throw new SandboxInputError(`You already have ${active.suites} suites generating. Wait for one to finish.`, 429);
    const suite = await store.insertSuite({ id: `drf_${randomUUID()}`, environmentId, ownerId, status: "generating", budgetMicroUsd: suiteCap });
    try {
      const wf = await executor.startSuite(suite.id);
      if (wf) await store.updateSuite(suite.id, { workflowRunId: wf });
      return { ...suite, workflowRunId: wf };
    } catch (e) {
      await store.updateSuite(suite.id, { status: "failed", error: "Could not start suite generation. Try again." });
      throw e;
    }
  }

  const service: EngineSandboxService = {
    kind: "engine",

    prebuiltEnvironments: () => listPrebuiltEnvs().map(({ id, name, domain }) => ({ id, name, domain })),

    async createEnvironment(ownerId, input) {
      await guardTarget(input.integration);
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
      const active = await store.countActive(ownerId);
      if (active.runs >= MAX_ACTIVE_RUNS) return { ok: false, status: 429, error: `You already have ${active.runs} runs in progress. Wait for one to finish.` };
      const envRow = await store.getEnvironment(ownerId, suite.environmentId);
      if (!envRow) return { ok: false, status: 404, error: "Draft not found" };
      const scenarios = chosen.map((d) => d.scenario);
      const run = await store.insertRun({
        id: `run_${randomUUID()}`, ownerId, environmentId: envRow.id, suiteId: suite.id, status: "queued", k, scenarios,
        gates: chosen.map((d) => ({ scenarioId: d.scenario.id, validated: d.validated ?? false, reasons: d.gateReasons ?? [] })),
        budgetMicroUsd: runCap, trialsTotal: scenarios.length * k,
      });
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

