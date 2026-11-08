/**
 * Sandbox evals engine (v0): generate → gate → run → grade. See docs/SANDBOX_EVALS_PLAN.md §8–§11.
 * Codes only against sandbox/spec.ts (SandboxRuntime/SandboxRun); never imports runtime/ or ingest/ internals.
 */
export { planSlots, scenarioId, generateScenarios, ScenarioDraft } from "./generate";
export { runGates, gateSuite, type GateReport, type GateOptions, type MutationOutcome } from "./gates";
export { llmSimulator, scriptedSimulator, attributeFailure, simulatorContradictions, parseTraits, applyTypos, addDistractor } from "./simulator";
export { toolLoopAgent, toolsForOpenAI, targetFromEnv, type ToolLoopTarget } from "./driver";
export { oracleAgent, doNothingAgent, emptyReplyAgent, dumpEverythingAgent, NULL_AGENTS } from "./agents";
export { gradeTrial, isRewardBearing, trialPassed, mentions, looksLikeRefusal } from "./graders";
export { runSuite, summarizeScenario, summarizeSuite, evalVersions, countedTrials, type RunSuiteOptions, type SuiteSummary } from "./runner";
export { runEpisode, type EpisodeInput } from "./episode";
export { wilsonInterval, budgetContext, canaryFor, extractCanaries } from "./util";
export * from "./types";
