import "server-only";
import { randomUUID } from "node:crypto";
import type { IntegrationMode } from "@ae/core/sandbox/spec";
import {
  SAMPLE_RUN_ID,
  type DraftScenario,
  type EnvironmentSummary,
  type SandboxDraft,
  type SandboxIntakeInput,
  type SandboxRunReport,
  type ScenarioReviewInput,
} from "@/components/sandbox/contract";
import {
  SAMPLE_POLICIES,
  SAMPLE_SCENARIOS,
  SAMPLE_WORKFLOWS,
  sampleClusters,
  sampleEnvironment,
  sampleMedia,
  sampleResults,
  sampleVerifiedFix,
  sampleVersions,
} from "@/components/sandbox/sample-data";
import { assertPublicTarget } from "./target-url";
import { createEngineSandboxService, type EngineSandboxService } from "./sandbox/engine-service";
import { createDbSandboxStore } from "./sandbox/store";
import { getCustomerPlan } from "@ae/core/payments/plans-checkout";
import { workflowSandboxExecutor } from "@/workflows/sandbox-start";

/**
 * App-side boundary to the sandbox engine. Pages and API routes talk ONLY to this interface.
 * `getSandboxService()` is engine-backed (sandbox/engine-service.ts: Postgres + durable workflows).
 * `createFixtureSandboxService` returns clearly labelled SAMPLE data (`sample: true`) for the sample run and tests.
 *
 * Every method takes the owner id and enforces ownership: a draft/run belonging to someone else is `null`
 * (callers render 404, never 403, so ids are not probeable).
 */
export interface SandboxService {
  readonly kind: "fixture" | "engine";
  createDraft(ownerId: string, input: SandboxIntakeInput): Promise<SandboxDraft>;
  getDraft(ownerId: string, draftId: string): Promise<SandboxDraft | null>;
  reviewScenario(ownerId: string, draftId: string, scenarioId: string, review: ScenarioReviewInput): Promise<SandboxDraft | null>;
  startRun(ownerId: string, draftId: string, opts: { k: number; scenarioIds?: string[]; validatedOnly?: boolean }): Promise<{ ok: true; runId: string } | { ok: false; status: 402 | 404 | 409 | 429; error: string }>;
  getRunReport(ownerId: string, runId: string): Promise<SandboxRunReport | null>;
}

/* ---------------- SSRF check for every customer URL in the integration ---------------- */

/** URLs in an IntegrationMode that we will connect to. wss:// is checked as https:// (same host rules). */
export function integrationTargets(integration: IntegrationMode): Array<{ field: string; url: string }> {
  switch (integration.mode) {
    case "tool_loop": return [{ field: "endpointUrl", url: integration.endpointUrl }];
    case "sandbox_api": return [{ field: "chatEndpointUrl", url: integration.chatEndpointUrl }];
    case "staging": return [{ field: "chatEndpointUrl", url: integration.chatEndpointUrl }];
    case "repo": return [{ field: "repoUrl", url: integration.repoUrl }];
    case "realtime_voice": return [{ field: "wsUrl", url: integration.wsUrl.replace(/^wss:/i, "https:") }];
  }
}

/** Returns the first rejected target ({field, reason}) or null when all are public. */
export async function checkIntegrationTargets(
  integration: IntegrationMode,
  assert: (url: string) => Promise<string | null> = assertPublicTarget,
): Promise<{ field: string; reason: string } | null> {
  if (integration.mode === "realtime_voice" && !/^wss:\/\//i.test(integration.wsUrl)) return { field: "wsUrl", reason: "voice socket must use wss://" };
  for (const t of integrationTargets(integration)) {
    const reason = await assert(t.url);
    if (reason) return { field: t.field, reason };
  }
  return null;
}

/* ---------------- best-effort tool-name extraction (fixture only; real parsing is ingest's job) ---------------- */

const TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

export function extractToolNames(format: NonNullable<SandboxIntakeInput["world"]>["tools"]["format"], content: string): string[] {
  try {
    if (format === "openapi") {
      const ids = [...content.matchAll(/"?operationId"?\s*:\s*"?([A-Za-z_][A-Za-z0-9_]*)"?/g)].map((m) => m[1]);
      return [...new Set(ids)].slice(0, 60);
    }
    const parsed: unknown = JSON.parse(content);
    const list = Array.isArray(parsed) ? parsed : (parsed as { tools?: unknown })?.tools;
    if (!Array.isArray(list)) return [];
    const names = list.map((t) => {
      const o = t as { name?: unknown; function?: { name?: unknown } };
      return typeof o?.name === "string" ? o.name : typeof o?.function?.name === "string" ? o.function.name : null;
    });
    return [...new Set(names.filter((n): n is string => !!n && TOOL_NAME.test(n)))].slice(0, 60);
  } catch {
    return [];
  }
}

/* ---------------- fixture implementation ---------------- */

interface StoredDraft { ownerId: string; draft: SandboxDraft }
interface StoredRun { ownerId: string; draftId: string; createdAt: string; k: number; acceptedIds: string[]; name: string; domain: string; mode: SandboxDraft["mode"] }
export interface FixtureStore { drafts: Map<string, StoredDraft>; runs: Map<string, StoredRun> }

export const newFixtureStore = (): FixtureStore => ({ drafts: new Map(), runs: new Map() });

const MAX_ITEMS_PER_STORE = 500;
const evictOldest = <V>(m: Map<string, V>) => { while (m.size >= MAX_ITEMS_PER_STORE) m.delete(m.keys().next().value as string); };

function buildEnvironment(input: SandboxIntakeInput): EnvironmentSummary {
  const base = sampleEnvironment();
  const names = input.world ? extractToolNames(input.world.tools.format, input.world.tools.content) : [];
  const tools = names.length > 0
    ? names.map((name) => ({ name, description: "Parsed from your input (descriptions arrive with the ingest engine).", effect: "read" as const, source: `${input.world?.tools.format ?? "prebuilt"}:${name}` }))
    : base.tools;
  return { ...base, tools };
}

function buildReport(run: { runId: string; draftId: string | null; createdAt: string; k: number; name: string; domain: string; mode: SandboxDraft["mode"]; acceptedIds?: string[] }): SandboxRunReport {
  const accepted = run.acceptedIds && run.acceptedIds.length > 0 ? new Set(run.acceptedIds) : null;
  const scenarios = accepted ? SAMPLE_SCENARIOS.filter((s) => accepted.has(s.id)) : SAMPLE_SCENARIOS;
  const results = sampleResults(run.k).filter((r) => scenarios.some((s) => s.id === r.scenarioId));
  return {
    runId: run.runId,
    draftId: run.draftId,
    name: run.name,
    domain: run.domain,
    mode: run.mode,
    status: "complete",
    sample: true,
    createdAt: run.createdAt,
    completedAt: run.createdAt,
    k: run.k,
    versions: sampleVersions(),
    scenarios,
    workflows: SAMPLE_WORKFLOWS.filter((w) => scenarios.some((s) => s.workflowId === w.id)),
    policies: SAMPLE_POLICIES,
    results,
    clusters: sampleClusters(results),
    verifiedFix: scenarios.some((s) => s.id === "sx_refund_day_31") ? sampleVerifiedFix(run.k) : null,
    media: sampleMedia().filter((m) => scenarios.some((s) => s.id === m.scenarioId)),
  };
}

const SAMPLE_CREATED_AT = "2026-06-01T15:00:00.000Z";

export function createFixtureSandboxService(store: FixtureStore = newFixtureStore(), now: () => Date = () => new Date()): SandboxService {
  const ownedDraft = (ownerId: string, draftId: string) => {
    const d = store.drafts.get(draftId);
    return d && d.ownerId === ownerId ? d : null;
  };
  return {
    kind: "fixture",

    async createDraft(ownerId, input) {
      const draftId = `drf_${randomUUID()}`;
      const scenarios: DraftScenario[] = SAMPLE_SCENARIOS.map((scenario) => ({ scenario, decision: "pending", edited: false }));
      const draft: SandboxDraft = {
        draftId,
        name: input.name,
        domain: input.domain,
        mode: input.integration.mode,
        createdAt: now().toISOString(),
        sample: true,
        status: "ready",
        environment: buildEnvironment(input),
        scenarios,
      };
      evictOldest(store.drafts);
      store.drafts.set(draftId, { ownerId, draft });
      return draft;
    },

    async getDraft(ownerId, draftId) {
      return ownedDraft(ownerId, draftId)?.draft ?? null;
    },

    async reviewScenario(ownerId, draftId, scenarioId, review) {
      const stored = ownedDraft(ownerId, draftId);
      if (!stored) return null;
      if (!stored.draft.scenarios.some((d) => d.scenario.id === scenarioId)) return null;
      const scenarios = stored.draft.scenarios.map((d) => {
        if (d.scenario.id !== scenarioId) return d;
        const e = review.edits;
        const edited = !!(e && (e.title || e.personaGoal));
        const scenario = edited
          ? { ...d.scenario, title: e?.title ?? d.scenario.title, persona: { ...d.scenario.persona, goal: e?.personaGoal ?? d.scenario.persona.goal } }
          : d.scenario;
        return { scenario, decision: review.decision, edited: d.edited || edited };
      });
      const draft = { ...stored.draft, scenarios };
      store.drafts.set(draftId, { ownerId, draft });
      return draft;
    },

    async startRun(ownerId, draftId, { k }) {
      const stored = ownedDraft(ownerId, draftId);
      if (!stored) return { ok: false, status: 404, error: "Draft not found" };
      const acceptedIds = stored.draft.scenarios.filter((d) => d.decision === "accepted").map((d) => d.scenario.id);
      if (acceptedIds.length === 0) return { ok: false, status: 409, error: "Accept at least one scenario before running" };
      const runId = `run_${randomUUID()}`;
      const { name, domain, mode } = stored.draft;
      evictOldest(store.runs);
      store.runs.set(runId, { ownerId, draftId, createdAt: now().toISOString(), k, acceptedIds, name, domain, mode });
      return { ok: true, runId };
    },

    async getRunReport(ownerId, runId) {
      if (runId === SAMPLE_RUN_ID) {
        return buildReport({ runId, draftId: null, createdAt: SAMPLE_CREATED_AT, k: 5, name: "Acme Support (sample)", domain: "E-commerce customer support", mode: "tool_loop" });
      }
      const run = store.runs.get(runId);
      if (!run || run.ownerId !== ownerId) return null;
      return buildReport({ runId, ...run });
    },
  };
}

/* ---------------- singleton ---------------- */

const g = globalThis as unknown as { __aeSandboxFixtureStore?: FixtureStore };

/** In-memory SAMPLE service (fixture data, `sample: true`). Used for /sandbox/runs/sample and tests. */
export function getFixtureSandboxService(): SandboxService {
  g.__aeSandboxFixtureStore ??= newFixtureStore();
  return createFixtureSandboxService(g.__aeSandboxFixtureStore);
}

/**
 * The service used by pages, routes and MCP tools: engine-backed (Postgres + Vercel Workflow). The sample run
 * (`/sandbox/runs/sample`) is still served from fixture data and labelled "Sample".
 */
export function getSandboxService(): EngineSandboxService {
  const sample = getFixtureSandboxService();
  return createEngineSandboxService({
    store: createDbSandboxStore(),
    executor: workflowSandboxExecutor,
    sampleReport: () => sample.getRunReport("", SAMPLE_RUN_ID),
    checkTarget: (integration) => checkIntegrationTargets(integration),
    planFor: (ownerId) => getCustomerPlan(ownerId),
  });
}
