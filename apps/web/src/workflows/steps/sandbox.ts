/**
 * Durable steps for Sandbox Evals. Each wraps one idempotent pipeline unit (apps/web/src/server/sandbox/pipeline.ts).
 * SandboxFatalError -> FatalError (never retried); other errors retry per maxRetries. Step I/O holds ids only.
 */
import { FatalError } from "workflow";
import {
  defaultPipelineDeps, failRun, failSuite, finalizeRun, gateSuiteScenarios, generateBriefScenario, generateSuiteScenarios, prepareRunWorld,
  runScenarioTrials, SandboxFatalError, teardownRunWorld,
} from "@/server/sandbox/pipeline";
import { createDbSandboxStore, runScenarios } from "@/server/sandbox/store";

const deps = () => defaultPipelineDeps(createDbSandboxStore());

async function fatalAware<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SandboxFatalError) throw new FatalError(`${e.kind === "budget" ? "[budget] " : ""}${e.message}`);
    throw e;
  }
}

export async function generateSandboxSuiteStep(suiteId: string): Promise<{ generated: number; failures: string[] }> {
  "use step";
  return fatalAware(() => generateSuiteScenarios(deps(), suiteId));
}
generateSandboxSuiteStep.maxRetries = 1;

export async function generateBriefScenarioStep(suiteId: string, req: { brief: string; category: Parameters<typeof generateBriefScenario>[2]["category"]; workflowId?: string }): Promise<{ generated: number; failures: string[] }> {
  "use step";
  return fatalAware(() => generateBriefScenario(deps(), suiteId, req));
}
generateBriefScenarioStep.maxRetries = 1;

export async function gateSandboxSuiteStep(suiteId: string): Promise<{ accepted: number; total: number }> {
  "use step";
  return fatalAware(() => gateSuiteScenarios(deps(), suiteId));
}
gateSandboxSuiteStep.maxRetries = 1;

export async function failSandboxSuiteStep(suiteId: string, message: string): Promise<void> {
  "use step";
  await failSuite(deps(), suiteId, message);
}

export async function prepareSandboxRunStep(runId: string): Promise<{ worldId: string; scenarioIds: string[] }> {
  "use step";
  return fatalAware(async () => {
    const d = deps();
    const { worldId } = await prepareRunWorld(d, runId);
    const run = await d.store.getRunById(runId);
    return { worldId, scenarioIds: run ? runScenarios(run).map((s) => s.id) : [] };
  });
}
prepareSandboxRunStep.maxRetries = 2;

export async function runSandboxScenarioStep(
  runId: string, scenarioId: string, worldId: string,
): Promise<{ status: "ok" | "budget_exhausted"; passed: number; trials: number }> {
  "use step";
  return fatalAware(() => runScenarioTrials(deps(), runId, scenarioId, worldId));
}
runSandboxScenarioStep.maxRetries = 1;

export async function finalizeSandboxRunStep(runId: string, budgetExhausted: boolean): Promise<{ passAt1: number; passHatK: number }> {
  "use step";
  return fatalAware(() => finalizeRun(deps(), runId, { budgetExhausted }));
}

export async function teardownSandboxRunStep(runId: string, worldId: string): Promise<void> {
  "use step";
  await teardownRunWorld(deps(), runId, worldId);
}
teardownSandboxRunStep.maxRetries = 3;

export async function failSandboxRunStep(runId: string, message: string, kind: "fatal" | "retryable" | "budget"): Promise<void> {
  "use step";
  await failRun(deps(), runId, message, kind);
}
