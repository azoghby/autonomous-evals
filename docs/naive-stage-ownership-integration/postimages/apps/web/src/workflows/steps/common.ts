import { FatalError } from "workflow";
import { executeWorkflowStage, type LogicalWorkflowStage } from "@/server/workflow-stage-runtime";
import type { ServiceContext } from "@ae/core/contracts/services";
import { getJob, makeServiceContext } from "@/server/job-store";
import { BUDGET_SHARE, type BudgetAgent } from "../decisions";

/** Result of a step that may stop on budget exhaustion instead of throwing (so it is never retried). */
export type BudgetResult<T> = { status: "ok"; data: T } | { status: "budget_exceeded"; message: string };

export async function requireJob(jobId: string) {
  const job = await getJob(jobId);
  if (!job) throw new FatalError(`Job ${jobId} not found`);
  return job;
}

/**
 * Claims one immutable logical operation under the shared job budget authority.
 * Completed retries replay a private result; pending/uncertain attempts retain their hold.
 * Child dispatch and publication composition must consume the trusted server stage scope.
 */
export async function withBudget<T>(
  jobId: string, agent: BudgetAgent, stage: LogicalWorkflowStage, run: (ctx: ServiceContext) => Promise<T>,
): Promise<BudgetResult<T>> {
  const job = await requireJob(jobId);
  const result = await executeWorkflowStage({ jobId, ownerId: job.customerId, environment: job.environment,
    role: agent, share: BUDGET_SHARE[agent], stage }, async amountMicroUsd => {
    const ctx = await makeServiceContext(jobId);
    ctx.budgetMicroUsd = amountMicroUsd;
    return run(ctx);
  });
  return result.ok ? { status: "ok", data: result.data } : {
    status: "budget_exceeded", message: `Per-job budget exhausted before the ${agent} stage (${result.remainingMicroUsd} micro-USD available).`,
  };
}

import type { IntakeInput } from "@ae/core/contracts/index";
import { getJobWithDecryptedCredentials } from "@/server/job-store";

const ENDPOINT_SLOTS = ["endpoint", "endpointA", "endpointB"] as const;

/** Loads the job's intake. With includeSecrets=false every apiKey is removed (use for anything agent-facing). */
export async function loadIntake(jobId: string, includeSecrets: boolean): Promise<IntakeInput> {
  const full = await getJobWithDecryptedCredentials(jobId);
  if (!full) throw new FatalError(`Job ${jobId} not found`);
  if (includeSecrets) return full.intake;
  const copy = { ...full.intake } as Record<string, unknown>;
  for (const slot of ENDPOINT_SLOTS) {
    const ep = copy[slot] as Record<string, unknown> | undefined;
    if (ep) {
      const { apiKey: _apiKey, ...rest } = ep;
      void _apiKey;
      copy[slot] = rest;
    }
  }
  return copy as IntakeInput;
}
