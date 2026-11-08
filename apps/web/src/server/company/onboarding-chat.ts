/**
 * Generative UI for Nova's chat: turns the onboarding conversation (collected requirements, suite draft, run report)
 * into typed tool outputs, and the stored transcript into AI SDK UIMessages. Pure except `hydrateMessages`, which
 * reads drafts/reports through the owner-scoped sandbox service.
 */
import { computeMissing, OnboardingRequirements, type RunPlan, type TranscriptEntry } from "@ae/core/company/onboarding";
import { summarizeRun } from "@ae/core/company/onboarding-report";
import type { SandboxDraft, SandboxRunReport } from "@/components/sandbox/contract";
import {
  modelOptions, type ConversationStatus, type CostEstimateOutput, type EnvironmentCardOutput, type EvidenceItem, type GateState,
  type IntakeChecklistOutput, type ModelPickerOutput, type NovaPart, type NovaToolName, type NovaTools, type NovaUIMessage,
  type ResultsSummaryOutput, type RunProgressOutput, type ScenarioPreviewItem, type ScenarioPreviewOutput, type StoredUiPart, type TrialCell,
} from "@/components/chat/nova-types";

const HOSTED = modelOptions().map((m) => m.id);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const kb = (s: string) => `${Math.max(1, Math.round(s.length / 1000))} KB`;
const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const usd = (micro: number | undefined) => Math.round((micro ?? 0) / 10_000) / 100;
export const runPath = (runId: string) => `/sandbox/runs/${encodeURIComponent(runId)}`;

/* ---------------- collecting ---------------- */

export function intakeChecklistView(collectedRaw: Record<string, unknown>, notes: string[] = []): IntakeChecklistOutput {
  const c = OnboardingRequirements.safeParse(collectedRaw).data ?? { agent: {}, tools: {} };
  const missing = computeMissing(c, { allowedModels: HOSTED });
  const agentMissing = missing.find((m) => /agent/.test(m) && !/tools/.test(m));
  const toolsMissing = missing.find((m) => /tool/.test(m) && /OpenAPI|sample/.test(m));
  const agentDetail = c.agent.endpointUrl && !agentMissing
    ? `Endpoint at ${host(c.agent.endpointUrl)}${c.agent.model ? `, model ${c.agent.model}` : ""}`
    : c.agent.model && c.agent.systemPrompt && !agentMissing
      ? `${c.agent.model} with a ${kb(c.agent.systemPrompt)} system prompt`
      : agentMissing ?? "An https endpoint, or a model plus its system prompt";
  const t = c.tools;
  const toolsDetail = t.prebuiltWorld ? "Acme sample world (orders, refunds, tickets)"
    : t.openapiText ? `OpenAPI spec, ${kb(t.openapiText)}`
      : t.mcpToolsJson ? `MCP tool list, ${kb(t.mcpToolsJson)}`
        : t.openapiUrl ? `OpenAPI spec at ${host(t.openapiUrl)}`
          : "An OpenAPI spec, your MCP tools/list JSON, or the Acme sample world";
  return {
    ready: missing.length === 0,
    notes,
    items: [
      { id: "agent", label: "Agent to test", required: true, state: agentMissing ? "missing" : "done", detail: agentDetail },
      { id: "tools", label: "Tools", required: true, state: toolsMissing ? "missing" : "done", detail: toolsDetail },
      { id: "data", label: "Schema or sample data", required: false, state: c.dataSample ? "done" : "optional", detail: c.dataSample ? `Schema, ${kb(c.dataSample)}` : t.prebuiltWorld ? "Included with the sample world" : "Optional. We infer tables from your tools" },
      { id: "policies", label: "Policies", required: false, state: c.policies ? "done" : "optional", detail: c.policies ? `${kb(c.policies)} of policy text` : "Optional. Rules your agent must follow" },
    ],
  };
}

export function modelPickerView(collectedRaw: Record<string, unknown>): ModelPickerOutput {
  const c = OnboardingRequirements.safeParse(collectedRaw).data ?? { agent: {}, tools: {} };
  return { models: modelOptions(), selected: c.agent.model && HOSTED.includes(c.agent.model) ? c.agent.model : null, hasSystemPrompt: !!c.agent.systemPrompt };
}

/** The picker only helps while the agent target is still missing and the customer has not given an endpoint. */
export function needsModelPicker(collectedRaw: Record<string, unknown>): boolean {
  const c = OnboardingRequirements.safeParse(collectedRaw).data ?? { agent: {}, tools: {} };
  return !c.agent.endpointUrl && intakeChecklistView(collectedRaw).items[0]!.state === "missing";
}

export function costEstimateView(plan: RunPlan & { headroomMicroUsd: number | null; runCapMicroUsd: number }, planName: string): CostEstimateOutput {
  return {
    scenarios: plan.scenarios, k: plan.k, trials: plan.scenarios * plan.k, estimateUsd: usd(plan.estimateMicroUsd),
    headroomUsd: plan.headroomMicroUsd == null ? null : usd(plan.headroomMicroUsd), runCapUsd: usd(plan.runCapMicroUsd), planName, blocked: plan.blocked,
  };
}

/* ---------------- building ---------------- */

export function environmentCardView(draft: SandboxDraft): EnvironmentCardOutput {
  const env = draft.environment;
  return {
    name: draft.name,
    source: draft.sample ? "prebuilt" : env.tools.some((t) => t.source === "prebuilt") ? "prebuilt" : "custom",
    tools: env.tools.slice(0, 24).map((t) => ({ name: t.name, effect: t.effect, description: clip(t.description ?? "", 140) })),
    tables: env.tables.slice(0, 24),
    policies: env.policies.slice(0, 12).map((p) => p.title),
    workflows: env.workflows.slice(0, 12).map((w) => w.name),
    warnings: [],
  };
}

function gatesOf(validated: boolean | undefined, reasons: string[]): ScenarioPreviewItem["gates"] {
  if (validated === undefined || reasons.includes("not gated")) return { oracle: "pending", null: "pending", mutation: "pending" };
  if (validated) return { oracle: "pass", null: "pass", mutation: "pass" };
  const oracleFail = reasons.some((r) => r.startsWith("oracle") || r.startsWith("gate error"));
  const nullFail = reasons.some((r) => r.startsWith("null agent"));
  const mutationFail = reasons.some((r) => r.startsWith("weak grader") || r.startsWith("no SQL mutation"));
  const after = (fail: boolean): GateState => (oracleFail ? "skipped" : fail ? "fail" : "pass");
  return { oracle: oracleFail ? "fail" : "pass", null: after(nullFail), mutation: after(mutationFail) };
}

export function scenarioPreviewView(draft: SandboxDraft): ScenarioPreviewOutput {
  const gated = draft.status === "ready" || draft.status === "failed";
  const scenarios = draft.scenarios.slice(0, 12).map((d): ScenarioPreviewItem => {
    const reasons = d.gateReasons ?? [];
    return {
      id: d.scenario.id, title: clip(d.scenario.title, 120), category: d.scenario.category,
      gates: gated ? gatesOf(d.validated, reasons) : { oracle: "pending", null: "pending", mutation: "pending" },
      validated: gated ? (d.validated ?? null) : null, reasons: reasons.slice(0, 3).map((r) => clip(r, 140)),
    };
  });
  return {
    status: draft.status, ...(draft.error ? { error: clip(draft.error, 300) } : {}), scenarios, total: draft.scenarios.length,
    validated: draft.scenarios.filter((d) => d.validated).length, costUsd: usd(draft.costMicroUsd),
  };
}

/* ---------------- running + reported ---------------- */

export function runProgressView(report: SandboxRunReport): RunProgressOutput {
  const byId = new Map(report.results.map((r) => [r.scenarioId, r]));
  const trialsTotal = report.progress?.trialsTotal ?? report.scenarios.length * report.k;
  const finishedTrials = report.results.reduce((s, r) => s + r.trials.length, 0);
  let inFlight = Math.max(0, (report.progress?.trialsDone ?? finishedTrials) - finishedTrials);
  const rows = report.scenarios.map((s) => {
    const r = byId.get(s.id);
    const cells: TrialCell[] = Array.from({ length: report.k }, (_, i) => {
      const t = r?.trials[i];
      if (t) return t.passed ? "pass" : "fail";
      if (report.status === "running" && inFlight > 0) { inFlight -= 1; return "running"; }
      return "pending";
    });
    return { scenarioId: s.id, title: clip(s.title, 100), category: s.category, cells };
  });
  return {
    runId: report.runId, status: report.status, k: report.k, trialsDone: report.status === "complete" ? trialsTotal : report.progress?.trialsDone ?? finishedTrials, trialsTotal,
    costUsd: usd(report.costMicroUsd), budgetUsd: usd(report.budgetMicroUsd), rows, ...(report.error ? { error: clip(report.error, 300) } : {}), runUrl: runPath(report.runId),
  };
}

export function resultsSummaryView(report: SandboxRunReport): ResultsSummaryOutput {
  const s = summarizeRun(report);
  const title = new Map(report.scenarios.map((x) => [x.id, x.title]));
  const evidence: EvidenceItem[] = [];
  for (const r of report.results) {
    for (const t of r.trials) {
      if (t.passed || evidence.length >= 8) continue;
      const failed = t.checks.find((c) => !c.passed);
      const turn = [...t.transcript].reverse().find((m) => m.role === "assistant" && m.content.trim()) ?? t.transcript.at(-1);
      evidence.push({
        id: `${r.scenarioId}:${t.trial}`, scenarioTitle: clip(title.get(r.scenarioId) ?? r.scenarioId, 90), trial: t.trial + 1,
        check: clip(failed?.detail ?? t.error ?? "Failed a check", 180), excerpt: clip(turn?.content.trim() ?? "", 260), role: turn?.role ?? "assistant",
      });
    }
  }
  const category = new Map(report.scenarios.map((x) => [x.id, x.category]));
  const cats = new Map<string, { passed: number; total: number }>();
  for (const r of report.results) {
    const c = category.get(r.scenarioId) ?? "happy_path";
    const cur = cats.get(c) ?? { passed: 0, total: 0 };
    cats.set(c, { passed: cur.passed + r.trials.filter((t) => t.passed).length, total: cur.total + r.trials.length });
  }
  return {
    runId: report.runId, k: report.k, scenarios: s.scenarios, trials: s.trials, passAt1: s.passAt1, passHatK: s.passHatK, ci95: s.ci95, costUsd: usd(s.costMicroUsd),
    byCategory: [...cats].map(([c, v]) => ({ category: c as ResultsSummaryOutput["byCategory"][number]["category"], ...v })),
    clusters: report.clusters.slice(0, 4).map((c) => ({
      id: c.id, title: clip(c.title, 120), rootCause: clip(c.rootCause, 240), severity: c.severity, attribution: c.attribution, trialCount: c.trialCount,
      evidence: evidence.filter((e) => c.scenarioIds.includes(e.id.split(":")[0]!)).map((e) => e.id).slice(0, 3),
    })),
    evidence,
    runUrl: runPath(report.runId),
  };
}

/* ---------------- which components a turn shows ---------------- */

export interface TurnUiInput {
  status: string;
  collected: Record<string, unknown>;
  awaitingConfirm?: boolean;
  suiteId?: string | null;
  notes?: string[];
  cost?: CostEstimateOutput;
}

/** Stored parts for the agent reply of one chat turn. Live parts (draft/run) are stored as references and hydrated on read. */
export function turnUiParts(t: TurnUiInput, idBase: string): StoredUiPart[] {
  const parts: StoredUiPart[] = [];
  const add = <N extends NovaToolName>(tool: N, input: NovaTools[N]["input"], output: NovaTools[N]["output"]) => parts.push({ tool, id: `${idBase}-${tool}`, input, output } as StoredUiPart);
  if (t.status === "collecting") {
    add("intakeChecklist", {}, intakeChecklistView(t.collected, t.notes));
    if (needsModelPicker(t.collected)) add("modelPicker", {}, modelPickerView(t.collected));
    if (t.awaitingConfirm && t.cost) add("costEstimate", {}, t.cost);
  }
  if (t.status === "building" && t.suiteId) {
    parts.push(ref("environmentCard", { suiteId: t.suiteId }, idBase), ref("scenarioPreview", { suiteId: t.suiteId }, idBase));
  }
  return parts;
}

const LIVE: ReadonlySet<NovaToolName> = new Set(["environmentCard", "scenarioPreview", "runProgress", "resultsSummary"]);
/** A live part's stored form: only the ids, so history always shows the current draft/run. */
const ref = (tool: NovaToolName, input: { suiteId: string } | { runId: string }, idBase: string): StoredUiPart =>
  ({ tool, id: `${idBase}-${tool}`, input, output: null }) as unknown as StoredUiPart;

export type ChatTranscriptEntry = TranscriptEntry & { ui?: StoredUiPart[] };

/** Sets `ui` on the last agent entry (immutable). */
export function withLastAgentUi(transcript: readonly ChatTranscriptEntry[], ui: StoredUiPart[]): ChatTranscriptEntry[] {
  const i = transcript.map((e) => e.role).lastIndexOf("agent");
  if (i < 0 || ui.length === 0) return [...transcript];
  return transcript.map((e, j) => (j === i ? { ...e, ui: [...(e.ui ?? []), ...ui.filter((p) => !(e.ui ?? []).some((q) => q.id === p.id))] } : e));
}

/** Live parts the current state implies but no entry references yet (the cron appends report text without UI). */
export function impliedLiveParts(conv: { status: string; runId: string | null; transcript: readonly ChatTranscriptEntry[] }): StoredUiPart[] {
  if (!conv.runId || (conv.status !== "running" && conv.status !== "reported" && conv.status !== "blocked")) return [];
  const has = (tool: NovaToolName) => conv.transcript.some((e) => e.ui?.some((p) => p.tool === tool && (p.input as { runId?: string }).runId === conv.runId));
  const base = `run-${conv.runId}`;
  const out: StoredUiPart[] = [];
  if (!has("runProgress")) out.push(ref("runProgress", { runId: conv.runId }, base));
  if (conv.status === "reported" && !has("resultsSummary")) out.push(ref("resultsSummary", { runId: conv.runId }, base));
  return out;
}

/* ---------------- transcript -> UIMessages ---------------- */

export interface LiveSources {
  getDraft(suiteId: string): Promise<SandboxDraft | null>;
  getRunReport(runId: string): Promise<SandboxRunReport | null>;
}

type ToolPart = Extract<NovaPart, { toolCallId: string }>;

/** Builds one tool part in its final state (or output-error when the live source is gone). */
export function toolPart(tool: NovaToolName, id: string, input: unknown, output: unknown | null, errorText?: string): ToolPart {
  const base = { type: `tool-${tool}`, toolCallId: id, input } as const;
  return (errorText || output == null
    ? { ...base, state: "output-error", errorText: errorText ?? "This is no longer available." }
    : { ...base, state: "output-available", output }) as unknown as ToolPart;
}

/** Resolves a stored part to a renderable tool part (live parts read the current draft/run). */
export async function toolPartFor(p: StoredUiPart, src: LiveSources, cache: Map<string, Promise<unknown>> = new Map()): Promise<ToolPart> {
  if (!LIVE.has(p.tool)) return toolPart(p.tool, p.id, p.input, p.output);
  const input = p.input as { suiteId?: string; runId?: string };
  const once = <T,>(key: string, f: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, f().catch(() => null));
    return cache.get(key) as Promise<T>;
  };
  if (input.suiteId) {
    const draft = await once(`d:${input.suiteId}`, () => src.getDraft(input.suiteId!));
    if (!draft) return toolPart(p.tool, p.id, p.input, null, "These scenarios are no longer available.");
    return toolPart(p.tool, p.id, p.input, p.tool === "environmentCard" ? environmentCardView(draft) : scenarioPreviewView(draft));
  }
  if (input.runId) {
    const report = await once(`r:${input.runId}`, () => src.getRunReport(input.runId!));
    if (!report) return toolPart(p.tool, p.id, p.input, null, "This run is no longer available.");
    if (p.tool === "resultsSummary" && report.status !== "complete") return toolPart(p.tool, p.id, p.input, null, report.error ?? "The run did not complete.");
    return toolPart(p.tool, p.id, p.input, p.tool === "runProgress" ? runProgressView(report) : resultsSummaryView(report));
  }
  return toolPart(p.tool, p.id, p.input, null);
}

/** Stable across polls (transcripts are capped, so positions shift; timestamps do not). */
export function messageIds(entries: ReadonlyArray<{ role: string; at: string }>): string[] {
  const seen = new Map<string, number>();
  return entries.map((e) => {
    const key = `${e.role === "customer" ? "u" : "a"}-${Date.parse(e.at) || 0}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n ? `${key}-${n}` : key;
  });
}

/** Transcript (plus implied live parts on the last agent entry) -> UIMessages with hydrated tool parts. */
export async function hydrateMessages(
  conv: { id: string; status: string; runId: string | null; transcript: readonly ChatTranscriptEntry[] }, src: LiveSources,
): Promise<NovaUIMessage[]> {
  const transcript = withLastAgentUi(conv.transcript, impliedLiveParts(conv));
  const cache = new Map<string, Promise<unknown>>();
  const status = conv.status as ConversationStatus;
  const entries = transcript.filter((e) => e.role === "customer" || e.role === "agent");
  const ids = messageIds(entries);
  return Promise.all(entries.map(async (e, i): Promise<NovaUIMessage> => {
    const tools = await Promise.all((e.ui ?? []).map((p) => toolPartFor(p, src, cache)));
    return {
      id: ids[i]!, role: e.role === "customer" ? "user" : "assistant",
      metadata: { conversationId: conv.id, status, at: e.at },
      parts: [{ type: "text", text: e.text, state: "done" }, ...tools],
    };
  }));
}
