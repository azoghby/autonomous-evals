import "server-only";
/**
 * Single dispatch table for the five company agents: used by the operator "Run now" route, the planner's
 * task dispatch, and the dry-run script. Every entry goes through runCompanyAgent (toggles, locks, budgets).
 */
import type { CompanyAgentId } from "@ae/core/company/registry";
import type { RunOptions, RunResult } from "./runtime";
import { runMarketResearchAgent } from "./market-research";
import { runProspectingAgent } from "./prospecting";
import { runOutreachAgent } from "./outreach";
import { runOnboardingFollowThrough } from "./onboarding";
import { runPlannerAgent } from "./planner";

export type AgentRunOpts = Omit<RunOptions, "deps">;

const RUNNERS: Record<Exclude<CompanyAgentId, "planner">, (opts: AgentRunOpts) => Promise<RunResult>> = {
  market_research: (o) => runMarketResearchAgent(o),
  prospecting: (o) => runProspectingAgent(o),
  outreach: (o) => runOutreachAgent(o),
  // Onboarding only works on customer-initiated conversations; a scheduled/dispatched run is its follow-through pass.
  onboarding: (o) => runOnboardingFollowThrough(o),
};

/** Planner with dispatch wired to the other agents (planner-triggered runs keep their own toggles + budgets). */
export function runPlannerWithDispatch(opts: AgentRunOpts): Promise<RunResult> {
  return runPlannerAgent(opts, {
    dispatch: (assignee) => RUNNERS[assignee as Exclude<CompanyAgentId, "planner">]({ trigger: "planner", dryRun: opts.dryRun, now: opts.now, env: opts.env }),
  });
}

export function runAgentById(id: CompanyAgentId, opts: AgentRunOpts): Promise<RunResult> {
  return id === "planner" ? runPlannerWithDispatch(opts) : RUNNERS[id](opts);
}
