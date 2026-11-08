import { z } from "zod";
import { jsonError, readJson, requireViewer } from "@/server/http";
import { clientIp, rateLimit } from "@/server/rate-limit";
import { chatHistory, copilotDeps, loadEvalContext, parseEvalRef } from "@/server/eval-chat/service";
import { CopilotBudgetError, streamCopilotTurn, toUserMessage } from "@/server/eval-chat/chat";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ kind: string; id: string }> };
const Body = z.object({ message: z.unknown() });
const noStore = { "Cache-Control": "no-store" };
const tooMany = (retryAfter: number) => Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });

/** Thread history, rehydrated action states and eval-specific suggestions. Owner only (404 otherwise). */
export async function GET(_req: Request, { params }: Ctx) {
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const { kind, id } = await params;
  const ref = parseEvalRef(kind, id);
  if (!ref) return jsonError(404, "Eval not found");
  try {
    const ctx = await loadEvalContext(auth.viewer, ref);
    if (!ctx) return jsonError(404, "Eval not found");
    return Response.json(await chatHistory(copilotDeps(), ctx), { headers: noStore });
  } catch (err) {
    console.error("eval chat history failed", err instanceof Error ? err.message : err);
    return jsonError(500, "Could not load this conversation");
  }
}

/** One user turn -> AI SDK UI message stream. The body carries only the new message; history comes from the DB. */
export async function POST(req: Request, { params }: Ctx) {
  const ipLimit = await rateLimit(`eval-chat-ip:${clientIp(req)}`, 120, 3600);
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfter);
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const userLimit = await rateLimit(`eval-chat:${auth.viewer.id}`, 60, 3600);
  if (!userLimit.ok) return tooMany(userLimit.retryAfter);
  const { kind, id } = await params;
  const ref = parseEvalRef(kind, id);
  if (!ref) return jsonError(404, "Eval not found");
  const body = await readJson(req, Body);
  if (!body.ok) return body.res;
  const msg = toUserMessage(body.data.message);
  if (!msg.ok) return jsonError(400, msg.error);
  try {
    const ctx = await loadEvalContext(auth.viewer, ref);
    if (!ctx) return jsonError(404, "Eval not found");
    return await streamCopilotTurn(copilotDeps(), ctx, msg.message, req.signal);
  } catch (err) {
    if (err instanceof CopilotBudgetError) return jsonError(429, err.message);
    console.error("eval chat turn failed", err instanceof Error ? err.message : err);
    return jsonError(500, "The copilot could not answer just now. Try again.");
  }
}
