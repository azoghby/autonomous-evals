import type { ServiceContext } from "../contracts/services";
import { createSessionStore } from "./sessions";
import { createBudgetReserver } from "./budget";
import { createArtifactStore } from "./artifacts";

/** The three optional ServiceContext adapters, all scoped to one job. */
export function createServiceAdapters(jobId: string): Required<Pick<ServiceContext, "sessions" | "budget" | "artifacts">> {
  return { sessions: createSessionStore(jobId), budget: createBudgetReserver(jobId), artifacts: createArtifactStore(jobId) };
}
