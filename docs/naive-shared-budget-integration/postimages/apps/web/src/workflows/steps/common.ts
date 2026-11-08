import { FatalError } from "workflow";
import { reserveWorkflowBudget, releaseWorkflowBudget } from "@ae/core/adapters/budget";
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
 * Reserves per-job budget for one agent-calling stage, runs it, then releases the reservation (actual
 * spend is recorded in costs by the services). A reservation left by a failed attempt is reused, not doubled.
 */
export async function withBudget<T>(
  jobId: string, agent: BudgetAgent, run: (ctx: ServiceContext) => Promise<T>,
): Promise<BudgetResult<T>> {
  await requireJob(jobId);
  // Admission and retry lookup share the same locked authority as Gateway and Naïve.
  const admission = await reserveWorkflowBudget(jobId, agent, BUDGET_SHARE[agent]);
  if (!admission.ok) {
    return {
      status: "budget_exceeded",
      message: `Per-job budget exhausted before the ${agent} stage (${admission.remainingMicroUsd} micro-USD available).`,
    };
  }
  const ctx = await makeServiceContext(jobId);
  // ServiceContext's legacy cap-minus-cost calculation ignores concurrent holds.
  ctx.budgetMicroUsd = admission.amountMicroUsd;
  const data = await run(ctx);
  // A thrown/uncertain provider call deliberately retains the hold for retry/reconciliation.
  // Release the entire stage only after all service calls and cost recording succeeded.
  await releaseWorkflowBudget(jobId, admission.reservationId);
  return { status: "ok", data };
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
