import "server-only";
import { start } from "workflow/api";
import type { SandboxExecutor } from "@/server/sandbox/engine-service";
import { sandboxRunWorkflow, sandboxSuiteWorkflow } from "./sandbox";

/** Starts Sandbox Evals work as durable Vercel Workflow runs. */
export const workflowSandboxExecutor: SandboxExecutor = {
  async startSuite(suiteId) { return (await start(sandboxSuiteWorkflow, [suiteId])).runId; },
  async startRun(runId) { return (await start(sandboxRunWorkflow, [runId])).runId; },
};
