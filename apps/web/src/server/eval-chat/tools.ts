/**
 * The copilot's tool set, bound to ONE authorized eval (EvalContext). Read tools return grounded cards; propose_* tools
 * only create server-stored proposals (actions.ts). Every output is secret-redacted before it reaches the model or the UI.
 */
import { tool } from "ai";
import { z } from "zod";
import { redactValue } from "@ae/core/agents/redact";
import { CONCEPT_TOPICS, SCENARIO_CATEGORIES } from "@/lib/eval-chat/types";
import { GATEWAY_TARGET_MODELS } from "@/components/sandbox/contract";
import {
  ActionError, isSandbox, proposeAddScenario, type JobContext, type SandboxContext, proposeRerun, proposeRerunFinding, proposeShare, type ActionDeps, type EvalContext,
} from "./actions";
import { explainConcept } from "./concepts";
import { compareRuns, evidence, GroundingError, resultsSummary, stateDiff, trialTimeline } from "./grounding";
import { findingEvidence, jobSummary } from "./job-grounding";
import { promptPatch } from "./patch";

const ScenarioRef = z.string().min(1).max(200).describe("Scenario id (sx_...) from the run context, or its exact title");
const Trial = z.number().int().min(1).max(10).optional().describe("1-based trial number; omit for the first failing trial");

/** Grounding/action errors become tool errors the model can read and the card can show; anything else is generic. */
async function guarded<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return redactValue(await fn()) as T;
  } catch (err) {
    if (err instanceof GroundingError || err instanceof ActionError) throw new Error(err.message);
    console.error("eval copilot tool failed", err instanceof Error ? err.message : err);
    throw new Error("That lookup failed. Try again.");
  }
}

const sandbox = (ctx: EvalContext): SandboxContext => {
  if (!isSandbox(ctx)) throw new GroundingError("This is an audit, not a sandbox run: use get_overview or get_finding.");
  return ctx;
};
const job = (ctx: EvalContext): JobContext => {
  if (isSandbox(ctx)) throw new GroundingError("This is a sandbox run, not an audit: findings live in audits.");
  return ctx;
};

export function buildEvalTools(ctx: EvalContext, deps: ActionDeps) {
  let addScenarioCalls = 0;
  return {
    get_overview: tool({
      description: "Headline results of this eval as a card: pass@1, pass^k, Wilson CI, per-scenario trial matrix, failure clusters, cost (audits: findings by severity and report summary). Use for 'how did it do', summaries, and before suggesting changes.",
      inputSchema: z.object({}),
      execute: () => guarded(() => (isSandbox(ctx) ? resultsSummary(sandbox(ctx).report) : jobSummary(job(ctx).job))),
    }),
    explain_failure: tool({
      description: "Evidence card for why a scenario trial failed (or passed): failed checks with severity and policy, the transcript excerpt where it went wrong, and state-diff rows. Use for any 'why did X fail' question.",
      inputSchema: z.object({ scenarioId: ScenarioRef, trial: Trial }),
      execute: ({ scenarioId, trial }) => guarded(() => evidence(sandbox(ctx).report, scenarioId, trial)),
    }),
    get_trial_timeline: tool({
      description: "Step-by-step timeline of one trial: customer and agent turns interleaved with tool calls (latency, errors, injected faults).",
      inputSchema: z.object({ scenarioId: ScenarioRef, trial: Trial }),
      execute: ({ scenarioId, trial }) => guarded(() => trialTimeline(sandbox(ctx).report, scenarioId, trial)),
    }),
    get_state_diff: tool({
      description: "Database rows one trial inserted/updated/deleted, with before and after values.",
      inputSchema: z.object({ scenarioId: ScenarioRef, trial: Trial }),
      execute: ({ scenarioId, trial }) => guarded(() => stateDiff(sandbox(ctx).report, scenarioId, trial)),
    }),
    compare_runs: tool({
      description: "Compare this run with another of the customer's runs (default: their most recent other run of the same agent). Per-scenario fixed/regressed/same.",
      inputSchema: z.object({ otherRunId: z.string().regex(/^run_[0-9a-f-]{36}$/).optional() }),
      execute: ({ otherRunId }) => guarded(async () => {
        const s = sandbox(ctx);
        const otherId = otherRunId ?? await defaultCompareRun(deps, s.ownerId, s.report);
        if (!otherId || otherId === s.ref.id) throw new GroundingError("There is no other run to compare with yet. Re-run this one first.");
        const other = await deps.sandbox.getRunReport(s.ownerId, otherId);
        if (!other) throw new GroundingError("That run was not found in your account.");
        return compareRuns(s.report, other);
      }),
    }),
    get_finding: tool({
      description: "Evidence card for one audit finding: description, evidence excerpts, reproductions and the suggested remediation.",
      inputSchema: z.object({ findingId: z.string().min(1).max(200).describe("Finding id from the audit context, or its title") }),
      execute: ({ findingId }) => guarded(() => findingEvidence(job(ctx).job, findingId)),
    }),
    explain_concept: tool({
      description: "Short explainer card for an evaluation concept. Pair it with one sentence tying it to this eval's numbers.",
      inputSchema: z.object({ topic: z.enum(CONCEPT_TOPICS), scenarioIds: z.array(z.string().max(80)).max(8).optional() }),
      execute: ({ topic, scenarioIds }) => guarded(() => explainConcept(topic, scenarioIds)),
    }),
    suggest_prompt_patch: tool({
      description: "Show a concrete system-prompt fix as a diff the customer can copy. `addition` is the new instruction text (specific, policy-grounded, under 120 words); `replace` optionally names exact existing text to replace. Only after reading the evidence for the failure it fixes.",
      inputSchema: z.object({
        title: z.string().min(3).max(120), rationale: z.string().min(3).max(600),
        addition: z.string().min(3).max(4_000), replace: z.string().max(4_000).optional(),
      }),
      execute: (input) => guarded(() => {
        const t = isSandbox(ctx) ? ctx.target : null;
        return promptPatch(t?.hosted ? t.systemPrompt : undefined, input, Boolean(t?.hosted));
      }),
    }),
    propose_add_scenario: tool({
      description: "Start generating ONE new scenario from the customer's description (or replace an existing one). This kicks off generation + gates (a few cents) and returns a preview card; nothing runs until the customer presses Confirm. Default scope 'new' runs only the new scenario.",
      inputSchema: z.object({
        brief: z.string().min(8).max(1_000).describe("The scenario idea in the customer's words, made concrete"),
        category: z.enum(SCENARIO_CATEGORIES),
        replaceScenarioId: z.string().max(200).optional(),
        k: z.number().int().min(1).max(10).optional(),
        scope: z.enum(["new", "all"]).optional(),
      }),
      execute: (input) => guarded(() => {
        if (++addScenarioCalls > 1) throw new ActionError("Only one new scenario per message. Ask for the next one after this card.");
        return proposeAddScenario(deps, ctx, input);
      }),
    }),
    propose_rerun: tool({
      description: `Propose re-running this run's scenarios (all, only failed, or selected) with a new k, and for hosted agents optionally a different model or system prompt. Returns a cost estimate card; nothing runs until Confirm. Hosted models: ${GATEWAY_TARGET_MODELS.join(", ")}.`,
      inputSchema: z.object({
        scope: z.enum(["all", "failed", "selected"]),
        scenarioIds: z.array(z.string().max(200)).max(12).optional(),
        k: z.number().int().min(1).max(10).optional(),
        model: z.string().max(80).optional(),
        systemPrompt: z.string().max(50_000).optional().describe("Full replacement system prompt (e.g. the patched prompt from suggest_prompt_patch)"),
      }),
      execute: (input) => guarded(() => proposeRerun(deps, ctx, input)),
    }),
    propose_share: tool({
      description: "Offer downloads and a public share link for this eval's report (audits only; creating the link needs Confirm).",
      inputSchema: z.object({}),
      execute: () => guarded(() => proposeShare(deps, ctx)),
    }),
    propose_rerun_finding: tool({
      description: "Propose re-running one audit finding to check whether it still reproduces (needs Confirm).",
      inputSchema: z.object({ findingId: z.string().min(1).max(200) }),
      execute: (input) => guarded(() => proposeRerunFinding(deps, ctx, input)),
    }),
  };
}

export type EvalToolSet = ReturnType<typeof buildEvalTools>;

async function defaultCompareRun(deps: ActionDeps, ownerId: string, report: { runId: string; name: string }): Promise<string | null> {
  const runs = (await deps.sandbox.listRuns(ownerId, 30)).filter((r) => r.runId !== report.runId && r.status === "complete");
  const base = report.name.replace(/\s*\(.*\)$/, "");
  return (runs.find((r) => r.name === report.name) ?? runs.find((r) => r.name.startsWith(base)) ?? runs[0])?.runId ?? null;
}
