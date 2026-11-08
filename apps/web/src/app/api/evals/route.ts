import { jsonError, requireViewer } from "@/server/http";
import { listEvals } from "@/server/eval-chat/service";

export const dynamic = "force-dynamic";

/** The signed-in customer's own evals (sandbox runs + audits) for the dashboard copilot list. */
export async function GET() {
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  try {
    return Response.json({ evals: await listEvals(auth.viewer) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("list evals failed", err instanceof Error ? err.message : err);
    return jsonError(500, "Could not load your evals");
  }
}
