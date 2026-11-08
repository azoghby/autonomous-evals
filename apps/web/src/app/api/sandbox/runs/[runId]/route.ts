import { jsonError, requireViewer } from "@/server/http";
import { getSandboxService } from "@/server/sandbox-service";

const RUN_ID = /^(sample|run_[0-9a-f-]{36})$/;

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const { runId } = await params;
  if (!RUN_ID.test(runId)) return jsonError(404, "Run not found");
  try {
    const report = await getSandboxService().getRunReport(auth.viewer.id, runId);
    return report ? Response.json({ report }) : jsonError(404, "Run not found");
  } catch (err) {
    console.error("get sandbox run failed", err);
    return jsonError(500, "Could not load run");
  }
}
