import { FatalError } from "workflow";
import { getEvalServices } from "./services";

/** Resolves a Neon branch's connection string from its id. Call only inside a step; never return or persist the result. */
export async function resolveBranchConnection(branchId: string): Promise<string> {
  const services = await getEvalServices();
  if (!services.getJobBranchConnection) throw new FatalError("Eval services cannot resolve branch connections");
  return services.getJobBranchConnection(branchId);
}
