/**
 * Copilot actions. The model can only PROPOSE: each propose_* tool validates against the eval it is grounded in and
 * stores the exact payload server-side. The client confirms by action id; execution reads the stored payload (never
 * client parameters) and goes through the existing services, so plan limits, trial allowances and budgets all apply.
 */
import { randomUUID } from "node:crypto";
import { GATEWAY_TARGET_MODELS, type SandboxRunReport } from "@/components/sandbox/contract";
import type {
  ActionResult, ActionStatus, CostEstimate, EvalRef, RerunCard, RerunFindingCard, ScenarioCategory, ScenarioPreviewCard, ShareCard,
} from "@/lib/eval-chat/types";
import type { EngineSandboxService, RunTarget } from "@/server/sandbox/engine-service";
import { GroundingError, findScenario } from "./grounding";
import { findFinding, type JobGroundingInput } from "./job-grounding";
import type { ActionRow, EvalChatStore } from "./store";

export const ACTION_TTL_MS = 30 * 60_000;
export const MAX_K = 10;
const FALLBACK_TRIAL_USD = 0.05;
const RUN_BUDGET_USD = () => Number(process.env.SANDBOX_RUN_BUDGET_USD ?? 3) || 3;

export type SandboxPort = Pick<EngineSandboxService, "getRunReport" | "getRunTarget" | "seedSuiteFromRun" | "getDraft" | "startRun" | "listRuns">;
export interface JobPort {
  rerunFinding(data: JobGroundingInput, findingId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  enableShare(jobId: string): Promise<{ url: string }>;
}

export interface ActionDeps {
  store: EvalChatStore;
  sandbox: SandboxPort;
  jobs: JobPort;
  now?: () => Date;
  /** Hourly cap on paid scenario generation (propose_add_scenario spends before Confirm). */
  allowScenarioGeneration?: (ownerId: string) => Promise<boolean>;
}

/** One authorized eval. Built by the route after the owner check; every tool and action runs against exactly this. */
export interface SandboxContext { ownerId: string; ref: EvalRef & { kind: "sandbox_run" }; report: SandboxRunReport; target: RunTarget | null }
export interface JobContext { ownerId: string; ref: EvalRef & { kind: "job" }; job: JobGroundingInput }
export type EvalContext = SandboxContext | JobContext;
export const isSandbox = (ctx: EvalContext): ctx is SandboxContext => ctx.ref.kind === "sandbox_run";

export class ActionError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = "ActionError"; }
}

const sandboxOnly = (ctx: EvalContext): SandboxContext => {
  if (!isSandbox(ctx)) throw new ActionError("That action is only available for sandbox runs.");
  return ctx;
};
const jobOnly = (ctx: EvalContext): JobContext => {
  if (isSandbox(ctx)) throw new ActionError("That action is only available for audits.");
  return ctx;
};

const clampK = (k: number | undefined, fallback: number) => Math.min(MAX_K, Math.max(1, Math.floor(k ?? fallback)));

export function estimate(report: SandboxRunReport, trials: number): CostEstimate {
  const done = report.results.reduce((s, r) => s + r.trials.length, 0);
  const spent = (report.costMicroUsd ?? 0) / 1e6;
  const perTrialUsd = done > 0 && spent > 0 ? spent / done : FALLBACK_TRIAL_USD;
  return {
    trials, perTrialUsd: round(perTrialUsd), totalUsd: round(perTrialUsd * trials), budgetUsd: RUN_BUDGET_USD(),
    basis: done > 0 && spent > 0 ? `This run averaged $${perTrialUsd.toFixed(3)} per trial over ${done} trials.` : "No spend recorded on this run yet; using a typical per-trial cost.",
  };
}
const round = (n: number) => Math.round(n * 10_000) / 10_000;

function assertSettled(report: SandboxRunReport) {
  if (report.sample) throw new ActionError("The sample report is read-only. Open one of your own runs to change it.");
  if (report.status === "queued" || report.status === "running") throw new ActionError("This run is still in progress. Wait for it to finish first.");
}

async function newAction<T extends Record<string, unknown>>(deps: ActionDeps, ctx: EvalContext, kind: ActionRow["kind"], payload: T) {
  const now = deps.now?.() ?? new Date();
  return deps.store.createAction({ id: `act_${randomUUID()}`, ownerId: ctx.ownerId, evalKind: ctx.ref.kind, evalId: ctx.ref.id, kind, payload, expiresAt: new Date(now.getTime() + ACTION_TTL_MS) });
}

/* ---------------- proposals ---------------- */

export async function proposeAddScenario(deps: ActionDeps, c: EvalContext, input: { brief: string; category: ScenarioCategory; replaceScenarioId?: string; k?: number; scope?: "new" | "all" }): Promise<ScenarioPreviewCard> {
  const ctx = sandboxOnly(c);
  assertSettled(ctx.report);
  const brief = input.brief.trim().slice(0, 1_000);
  if (brief.length < 8) throw new ActionError("Describe the scenario in a sentence so it can be generated.", 400);
  const replaces = input.replaceScenarioId ? findScenario(ctx.report, input.replaceScenarioId).id : null;
  if (deps.allowScenarioGeneration && !(await deps.allowScenarioGeneration(ctx.ownerId))) throw new ActionError("You have generated several scenarios in the last hour. Try again later.", 429);
  const draft = await deps.sandbox.seedSuiteFromRun(ctx.ownerId, ctx.ref.id, { brief: { brief, category: input.category }, ...(replaces ? { removeScenarioIds: [replaces] } : {}) });
  if (!draft) throw new ActionError("Run not found.", 404);
  const k = clampK(input.k, 1);
  const scope = input.scope ?? "new";
  const baseScenarioIds = ctx.report.scenarios.map((s) => s.id).filter((id) => id !== replaces);
  const trials = (scope === "new" ? 1 : baseScenarioIds.length + 1) * k;
  const payload = { draftId: draft.draftId, k, scope, baseScenarioIds, brief, category: input.category, replacesScenarioId: replaces };
  const row = await newAction(deps, ctx, "add_scenario", payload);
  return { actionId: row.id, kind: "add_scenario", status: row.status, expiresAt: row.expiresAt.toISOString(), ...payload, estimate: estimate(ctx.report, trials) };
}

export async function proposeRerun(deps: ActionDeps, c: EvalContext, input: { scope: "all" | "failed" | "selected"; scenarioIds?: string[]; k?: number; model?: string; systemPrompt?: string }): Promise<RerunCard> {
  const ctx = sandboxOnly(c);
  assertSettled(ctx.report);
  const { report, target } = ctx;
  const failed = report.results.filter((r) => r.trials.some((t) => !t.passed)).map((r) => r.scenarioId);
  const scenarioIds = input.scope === "all" ? report.scenarios.map((s) => s.id)
    : input.scope === "failed" ? failed
    : [...new Set((input.scenarioIds ?? []).map((id) => findScenario(report, id).id))];
  if (scenarioIds.length === 0) throw new ActionError(input.scope === "failed" ? "Nothing failed in this run, so there is nothing to re-run." : "Pick at least one scenario.", 400);
  const changesTarget = Boolean(input.model || input.systemPrompt);
  if (changesTarget && !target?.hosted) throw new ActionError("Model and prompt can only be changed for hosted agents. Change them in your own deployment and re-run.", 400);
  if (input.model && !(GATEWAY_TARGET_MODELS as readonly string[]).includes(input.model)) {
    throw new ActionError(`That model is not available for hosted runs. Choose one of: ${GATEWAY_TARGET_MODELS.join(", ")}.`, 400);
  }
  const k = clampK(input.k, report.k);
  const payload = { scope: input.scope, scenarioIds, k, model: input.model ?? null, systemPrompt: input.systemPrompt?.slice(0, 50_000) ?? null };
  const row = await newAction(deps, ctx, "rerun", payload);
  return {
    actionId: row.id, kind: "rerun", status: row.status, expiresAt: row.expiresAt.toISOString(),
    scope: input.scope, scenarioIds, k, model: payload.model, currentModel: target?.model ?? null, promptChanged: Boolean(payload.systemPrompt),
    ...(payload.systemPrompt ? { promptPreview: payload.systemPrompt.slice(0, 2_000) } : {}),
    estimate: estimate(report, scenarioIds.length * k),
  };
}

const DOWNLOADS = [["Report (PDF-ready HTML)", "report-html"], ["Report (Markdown)", "report"], ["Test suite", "suite"], ["Evidence bundle", "evidence"]] as const;

export async function proposeShare(deps: ActionDeps, c: EvalContext): Promise<ShareCard> {
  if (isSandbox(c)) {
    const ctx = c;
    const row = await newAction(deps, ctx, "share_report", {});
    await deps.store.transitionAction(row.id, "proposed", "cancelled");
    return { actionId: row.id, kind: "share_report", status: "cancelled", expiresAt: row.expiresAt.toISOString(), downloads: [{ label: "Run report", href: `/sandbox/runs/${ctx.ref.id}` }], shareable: false, reason: "Sandbox reports are private to your account. Public share links are available on delivered audits." };
  }
  const ctx = jobOnly(c);
  const delivered = ctx.job.job.state === "delivered";
  const row = await newAction(deps, ctx, "share_report", {});
  return {
    actionId: row.id, kind: "share_report", status: row.status, expiresAt: row.expiresAt.toISOString(),
    downloads: delivered ? DOWNLOADS.map(([label, kind]) => ({ label, href: `/api/jobs/${ctx.ref.id}/artifacts/${kind}` })) : [],
    shareable: delivered, reason: delivered ? null : "Share links and downloads unlock when the audit is delivered.",
  };
}

export async function proposeRerunFinding(deps: ActionDeps, c: EvalContext, input: { findingId: string }): Promise<RerunFindingCard> {
  const ctx = jobOnly(c);
  const f = findFinding(ctx.job, input.findingId);
  if (ctx.job.job.state !== "delivered") throw new ActionError("Findings can be re-run once the audit is delivered.");
  const row = await newAction(deps, ctx, "rerun_finding", { findingId: f.id });
  return { actionId: row.id, kind: "rerun_finding", status: row.status, expiresAt: row.expiresAt.toISOString(), findingId: f.id, title: f.title };
}

/* ---------------- confirm / cancel ---------------- */

const view = (r: ActionRow, extra: Partial<ActionResult> = {}): ActionResult => ({ actionId: r.id, status: r.status, ...(r.result as Partial<ActionResult> | null ?? {}), ...extra });

/** Latest state of every action in a thread, for cards rehydrating after reload. */
export async function actionStates(store: EvalChatStore, ownerId: string, ref: EvalRef, now = new Date()): Promise<Record<string, ActionResult>> {
  const rows = await store.listActions(ownerId, ref);
  return Object.fromEntries(rows.map((r) => [r.id, view(r.status === "proposed" && r.expiresAt < now ? { ...r, status: "expired" } : r)]));
}

export async function decideAction(deps: ActionDeps, ctx: EvalContext, actionId: string, decision: "confirm" | "cancel"): Promise<ActionResult> {
  const row = await deps.store.getAction(ctx.ownerId, ctx.ref, actionId);
  if (!row) throw new ActionError("Action not found.", 404);
  const now = deps.now?.() ?? new Date();
  if (row.status !== "proposed") return view(row);
  if (row.expiresAt < now) {
    const r = await deps.store.transitionAction(row.id, "proposed", "expired");
    return view(r ?? row, { status: "expired", error: "This proposal expired. Ask again to get a fresh estimate." });
  }
  if (decision === "cancel") {
    const r = await deps.store.transitionAction(row.id, "proposed", "cancelled");
    return view(r ?? row);
  }
  // Not-ready-yet is not a failure: leave the proposal open so the customer can confirm again.
  const notReady = await readiness(deps, ctx, row);
  if (notReady) return view(row, { error: notReady });
  const claimed = await deps.store.transitionAction(row.id, "proposed", "executing");
  if (!claimed) return view((await deps.store.getAction(ctx.ownerId, ctx.ref, actionId)) ?? row);
  try {
    const { stored, extra } = await execute(deps, ctx, claimed);
    const done = await deps.store.transitionAction(row.id, "executing", "executed", stored);
    return view(done ?? claimed, { status: "executed", ...stored, ...extra });
  } catch (err) {
    const error = err instanceof ActionError || err instanceof GroundingError ? err.message : "Could not complete that action. Try again.";
    if (!(err instanceof ActionError || err instanceof GroundingError)) console.error("eval copilot action failed", err instanceof Error ? err.message : err);
    const failed = await deps.store.transitionAction(row.id, "executing", "failed", { error });
    return view(failed ?? claimed, { status: "failed" as ActionStatus, error });
  }
}

/** A reason the action cannot run YET (state may change), or null. Terminal problems are left to execute(). */
async function readiness(deps: ActionDeps, ctx: EvalContext, row: ActionRow): Promise<string | null> {
  if (row.kind !== "add_scenario") return null;
  const draft = await deps.sandbox.getDraft(ctx.ownerId, String(row.payload.draftId));
  if (draft && (draft.status === "generating" || draft.status === "gating")) return "The scenario is still being generated and checked. Confirm again when the gates finish.";
  return null;
}

type Executed = { stored: Record<string, unknown>; extra?: Partial<ActionResult> };

async function execute(deps: ActionDeps, ctx: EvalContext, row: ActionRow): Promise<Executed> {
  const p = row.payload;
  switch (row.kind) {
    case "add_scenario": {
      const draft = await deps.sandbox.getDraft(ctx.ownerId, String(p.draftId));
      if (!draft) throw new ActionError("The draft for this scenario is gone. Ask again.", 404);
      if (draft.status === "failed") throw new ActionError(`Generating the scenario failed: ${draft.error ?? "unknown error"}`);
      if (draft.status !== "ready") throw new ActionError("The scenario is still being generated and checked. Confirm again in a moment.");
      const base = new Set(p.baseScenarioIds as string[]);
      const added = draft.scenarios.filter((d) => !base.has(d.scenario.id));
      if (!added.some((d) => d.validated)) throw new ActionError("The new scenario did not pass the gates, so it would not be a fair test. Try describing it differently.");
      const scenarioIds = p.scope === "all" ? draft.scenarios.filter((d) => d.validated || base.has(d.scenario.id)).map((d) => d.scenario.id) : added.filter((d) => d.validated).map((d) => d.scenario.id);
      return started(await deps.sandbox.startRun(ctx.ownerId, draft.draftId, { k: Number(p.k), scenarioIds }));
    }
    case "rerun": {
      const s = sandboxOnly(ctx);
      const keep = new Set(p.scenarioIds as string[]);
      const removeScenarioIds = s.report.scenarios.map((x) => x.id).filter((id) => !keep.has(id));
      const target = p.model || p.systemPrompt ? { ...(p.model ? { model: String(p.model) } : {}), ...(p.systemPrompt ? { systemPrompt: String(p.systemPrompt) } : {}) } : undefined;
      const draft = await deps.sandbox.seedSuiteFromRun(ctx.ownerId, ctx.ref.id, { removeScenarioIds, ...(target ? { target } : {}) });
      if (!draft) throw new ActionError("Run not found.", 404);
      return started(await deps.sandbox.startRun(ctx.ownerId, draft.draftId, { k: Number(p.k), scenarioIds: [...keep] }));
    }
    case "share_report": {
      const j = jobOnly(ctx);
      if (j.job.job.state !== "delivered") throw new ActionError("Only delivered audits can be shared.");
      const { url } = await deps.jobs.enableShare(ctx.ref.id);
      // The token is shown once and never stored (same rule as the share route).
      return { stored: { shared: true }, extra: { shareUrl: url } };
    }
    case "rerun_finding": {
      const j = jobOnly(ctx);
      const r = await deps.jobs.rerunFinding(j.job, String(p.findingId));
      if (!r.ok) throw new ActionError(r.error, r.status);
      return { stored: { rerunStarted: true } };
    }
  }
}

function started(r: Awaited<ReturnType<SandboxPort["startRun"]>>): Executed {
  if (!r.ok) throw new ActionError(r.error, r.status);
  return { stored: { runId: r.runId, runUrl: `/sandbox/runs/${r.runId}` } };
}
