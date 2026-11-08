import { ChatError } from "@ae/core/reporting/chat/index";
import { progressChatForRequest } from "@/server/progress-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ jobId: string }> };
const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie" };
const statuses = { unauthenticated: 401, not_found: 404, invalid_input: 400, conflict: 409,
  invalid_snapshot: 503, storage_error: 503 } as const;
function fail(error: unknown) {
  return Response.json({ error: error instanceof ChatError ? error.message : "Private progress chat is unavailable." },
    { status: error instanceof ChatError ? statuses[error.code] : 503, headers });
}
function integer(value: string | null, fallback: number) {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new ChatError("invalid_input");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new ChatError("invalid_input");
  return number;
}
export async function GET(req: Request, ctx: Context) {
  try {
    const { jobId } = await ctx.params;
    const service = await progressChatForRequest(jobId);
    const query = new URL(req.url).searchParams;
    if (query.get("mode") === "poll") {
      const cursor = query.get("cursor");
      return Response.json(await service.poll({ jobId, ...(cursor === null ? {} : { cursor }) }), { headers });
    }
    if (query.has("mode")) throw new ChatError("invalid_input");
    const limit = integer(query.get("limit"), 20);
    const page = await service.history({ jobId, afterSequence: integer(query.get("afterSequence"), 0), limit });
    return Response.json({ exchanges: page.messages, nextAfterSequence: page.nextAfterSequence,
      hasMore: page.messages.length === limit }, { headers });
  } catch (error) { return fail(error); }
}
export async function POST(req: Request, ctx: Context) {
  try {
    // Cookie-authenticated write, same origin only. It never resumes an evaluation.
    if (req.headers.get("origin") !== new URL(req.url).origin) throw new ChatError("invalid_input");
    const { jobId } = await ctx.params;
    const service = await progressChatForRequest(jobId);
    // Bound streamed JSON before parsing, even without Content-Length.
    const reader = req.body?.getReader();
    if (!reader) throw new ChatError("invalid_input");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; if (size > 12000) { await reader.cancel(); throw new ChatError("invalid_input"); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ChatError("invalid_input"); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join() !== "messageId,text") throw new ChatError("invalid_input");
    const input = body as {messageId: unknown; text: unknown};
    const exchange = await service.send({ jobId, messageId: input.messageId, question: input.text });
    return Response.json({ exchange }, { headers });
  } catch (error) { return fail(error); }
}
