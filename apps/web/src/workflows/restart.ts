import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { decideResumePlan, isRestartablePlan, type ResumePhase } from "./decisions";
import { startJobWorkflow } from "./events";
import { jobRunLiveness } from "./resume";
import { loadResumeSnapshot } from "./steps/resume";

export type RestartStatus = "restarted" | "alreadyRunning" | "notRestartable";

export interface RestartResult {
  status: RestartStatus;
  /** Human/operator-readable reason (no secrets). */
  reason: string;
  /** restarted: the new run; alreadyRunning: the owner of the token when known. */
  runId?: string;
  /** Where the new run resumes (restarted / alreadyRunning when computable). */
  phase?: ResumePhase;
}

/**
 * Starts a fresh jobWorkflow run for a job whose previous run is dead (its job:<id> hook is gone or its run is
 * terminal). The new run derives its starting phase from persisted state (decideResumePlan) and skips completed
 * phases. Never starts a second run while one is alive: liveness is checked first and the start itself is
 * guarded by the hook token (HookConflictError -> alreadyRunning), so concurrent callers are safe.
 * Throws only on unexpected infrastructure errors (DB / World); callers should catch and escalate.
 */
export async function restartJobWorkflow(jobId: string): Promise<RestartResult> {
  const snap = await loadResumeSnapshot(jobId);
  if (!snap) return { status: "notRestartable", reason: "job not found" };
  const plan = decideResumePlan(snap);
  if (!isRestartablePlan(plan)) {
    return { status: "notRestartable", reason: "reason" in plan ? plan.reason : plan.phase, phase: plan.phase };
  }

  const liveness = await jobRunLiveness(jobId);
  if (liveness === "alive") return { status: "alreadyRunning", reason: "the job's workflow run is still active", phase: plan.phase };
  if (liveness === "unknown") return { status: "notRestartable", reason: "run liveness could not be determined; retry later", phase: plan.phase };

  const started = await startJobWorkflow(jobId);
  if (started.alreadyStarted || !started.runId) {
    return {
      status: "alreadyRunning", reason: "another run holds the job hook token (concurrent restart or run still ending)",
      ...(started.conflictingRunId ? { runId: started.conflictingRunId } : {}), phase: plan.phase,
    };
  }
  await db().update(schema.jobs).set({ workflowRunId: started.runId }).where(eq(schema.jobs.id, jobId));
  return { status: "restarted", reason: `previous run was dead; new run resumes at ${plan.phase}`, runId: started.runId, phase: plan.phase };
}
