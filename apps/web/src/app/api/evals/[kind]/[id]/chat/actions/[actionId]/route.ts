import { z } from "zod";
import { jsonError, readJson, requireViewer } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { copilotDeps, loadEvalContext, parseEvalRef } from "@/server/eval-chat/service";
import { ActionError, decideAction } from "@/server/eval-chat/actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ kind: string; id: string; actionId: string }> };
const Body = z.object({ decision: z.enum(["confirm", "cancel"]) });
const ACTION_ID = /^act_[0-9a-f-]{36}$/;

/** Confirm or cancel a proposal. Executes the payload stored at proposal time, never anything from this request. */
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const rl = await rateLimit(`eval-chat-action:${auth.viewer.id}`, 30, 600);
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  const { kind, id, actionId } = await params;
  const ref = parseEvalRef(kind, id);
  if (!ref || !ACTION_ID.test(actionId)) return jsonError(404, "Action not found");
  const body = await readJson(req, Body);
  if (!body.ok) return body.res;
  try {
    const ctx = await loadEvalContext(auth.viewer, ref);
    if (!ctx) return jsonError(404, "Action not found");
    const result = await decideAction(copilotDeps(), ctx, actionId, body.data.decision);
    return Response.json(result, { status: result.status === "failed" ? 409 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ActionError) return jsonError(err.status, err.message);
    console.error("eval chat action failed", err instanceof Error ? err.message : err);
    return jsonError(500, "Could not complete that action. Try again.");
  }
}
