import { ScenarioReviewInput } from "@/components/sandbox/contract";
import { jsonError, readJson, requireViewer } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { getSandboxService } from "@/server/sandbox-service";

const DRAFT_ID = /^drf_[0-9a-f-]{36}$/;
const SCENARIO_ID = /^sx_[a-z0-9_]{1,60}$/;

export async function PATCH(req: Request, { params }: { params: Promise<{ draftId: string; scenarioId: string }> }) {
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const rl = await rateLimit(`sandbox-review:${auth.viewer.id}`, 300, 600);
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  const { draftId, scenarioId } = await params;
  if (!DRAFT_ID.test(draftId) || !SCENARIO_ID.test(scenarioId)) return jsonError(404, "Scenario not found");
  const body = await readJson(req, ScenarioReviewInput);
  if (!body.ok) return body.res;
  try {
    const draft = await getSandboxService().reviewScenario(auth.viewer.id, draftId, scenarioId, body.data);
    return draft ? Response.json({ draft }) : jsonError(404, "Scenario not found");
  } catch (err) {
    console.error("review sandbox scenario failed", err);
    return jsonError(500, "Could not update scenario");
  }
}
