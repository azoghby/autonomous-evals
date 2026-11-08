import { handleGetRegressionRun } from "@/server/regression-api";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  return handleGetRegressionRun(req, runId);
}
