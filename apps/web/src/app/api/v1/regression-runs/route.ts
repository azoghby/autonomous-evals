import { after } from "next/server";
import { handleCreateRegressionRun } from "@/server/regression-api";

export const dynamic = "force-dynamic";
/** The sync window is ~50s; `after` lets a longer run finish and persist for GET polling. */
export const maxDuration = 300;

/** POST /api/v1/regression-runs: re-run a job's frozen suite against a target (CI regression gate). */
export async function POST(req: Request) {
  return handleCreateRegressionRun(req, { defer: (p) => after(() => p) });
}
