import { FatalError } from "workflow";
import {
  failSandboxRunStep, failSandboxSuiteStep, finalizeSandboxRunStep, gateSandboxSuiteStep, generateSandboxSuiteStep,
  prepareSandboxRunStep, runSandboxScenarioStep, teardownSandboxRunStep,
} from "./steps/sandbox";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 800);
const kindOf = (e: unknown): "fatal" | "retryable" | "budget" =>
  e instanceof FatalError || (e instanceof Error && e.name === "FatalError")
    ? (reason(e).startsWith("[budget]") ? "budget" : "fatal")
    : "retryable";

/** Suite: generate one scenario per category, then run the automatic gates. Ends ready or failed. */
export async function sandboxSuiteWorkflow(suiteId: string): Promise<{ suiteId: string; status: "ready" | "failed" }> {
  "use workflow";
  try {
    await generateSandboxSuiteStep(suiteId);
    await gateSandboxSuiteStep(suiteId);
    return { suiteId, status: "ready" };
  } catch (e) {
    await failSandboxSuiteStep(suiteId, reason(e));
    return { suiteId, status: "failed" };
  }
}

/**
 * Run: provision one Neon world, run k trials per scenario (one durable step per scenario, so a crash re-runs at
 * most one scenario), finalize pass^k + Wilson CI, and always tear the world down (the branch also has a TTL).
 */
export async function sandboxRunWorkflow(runId: string): Promise<{ runId: string; status: "complete" | "failed" }> {
  "use workflow";
  let worldId: string | undefined;
  try {
    const prepared = await prepareSandboxRunStep(runId);
    worldId = prepared.worldId;
    let exhausted = false;
    for (const scenarioId of prepared.scenarioIds) {
      const r = await runSandboxScenarioStep(runId, scenarioId, worldId);
      if (r.status === "budget_exhausted") { exhausted = true; break; }
    }
    await finalizeSandboxRunStep(runId, exhausted);
    return { runId, status: "complete" };
  } catch (e) {
    await failSandboxRunStep(runId, reason(e), kindOf(e));
    return { runId, status: "failed" };
  } finally {
    if (worldId) {
      try { await teardownSandboxRunStep(runId, worldId); } catch { /* best effort: the branch expires on its TTL */ }
    }
  }
}
