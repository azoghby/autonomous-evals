import "server-only";
import { start, resumeHook } from "workflow/api";
import { HookConflictError } from "workflow/errors";
import { type JobEvent, jobHookToken } from "@ae/core/contracts/index";
import { jobWorkflow } from "./job";

export interface StartJobResult {
  runId: string | null;
  alreadyStarted: boolean;
  /** On a duplicate start: the run that owns the job:<id> token, when the World reports it. */
  conflictingRunId?: string;
}

/**
 * Starts the job's workflow exactly once per live run. The start hook (token job:<id>) exists from admission,
 * so events sent before the workflow reaches its await are buffered, not lost. The token is released when the
 * run ends, so a later start (restartJobWorkflow) is admitted as a new run that resumes from persisted state.
 * Duplicate starts throw HookConflictError; callers treat that as "already started".
 */
export async function startJobWorkflow(jobId: string): Promise<StartJobResult> {
  try {
    const run = await start(jobWorkflow, [jobId], { experimental_hook: { token: jobHookToken(jobId) } });
    return { runId: run.runId, alreadyStarted: false };
  } catch (err) {
    if (HookConflictError.is(err) || (err instanceof Error && err.name === "HookConflictError")) {
      const conflictingRunId = HookConflictError.is(err) ? err.conflictingRunId : undefined;
      return { runId: null, alreadyStarted: true, ...(conflictingRunId ? { conflictingRunId } : {}) };
    }
    throw err;
  }
}

/** Delivers an event to the job workflow. Caller must authorize first; the token is not a secret. */
export async function sendJobEvent(jobId: string, event: JobEvent): Promise<void> {
  await resumeHook(jobHookToken(jobId), event);
}
