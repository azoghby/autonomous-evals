import "server-only";
import { start, resumeHook } from "workflow/api";
import { type JobEvent, jobHookToken } from "@ae/core/contracts/index";
import { jobWorkflow } from "./job";

/**
 * Starts the job's workflow exactly once. The start hook (token job:<id>) exists from admission,
 * so events sent before the workflow reaches its await are buffered, not lost.
 * Duplicate starts throw HookConflictError; callers treat that as "already started".
 */
export async function startJobWorkflow(jobId: string): Promise<{ runId: string | null; alreadyStarted: boolean }> {
  try {
    const run = await start(jobWorkflow, [jobId], { experimental_hook: { token: jobHookToken(jobId) } });
    return { runId: run.runId, alreadyStarted: false };
  } catch (err) {
    if (err instanceof Error && err.name === "HookConflictError") return { runId: null, alreadyStarted: true };
    throw err;
  }
}

/** Delivers an event to the job workflow. Caller must authorize first; the token is not a secret. */
export async function sendJobEvent(jobId: string, event: JobEvent): Promise<void> {
  await resumeHook(jobHookToken(jobId), event);
}
