import { jsonError } from "@/server/http";
import { clientIp } from "@/server/rate-limit";
import { assertHuman } from "@/server/bot";
import { submitFeedback } from "@/server/feedback";

const MAX_BODY_CHARS = 16_000;

/** Public feedback form (/feedback). BotID + per-IP rate limit. Returns { ok: true } | { error, fieldErrors? }. */
export async function POST(req: Request) {
  const blocked = await assertHuman(); if (blocked) return blocked;
  const text = await req.text().catch(() => "");
  if (text.length > MAX_BODY_CHARS) return jsonError(400, "Request too large");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return jsonError(400, "Invalid JSON body"); }
  try {
    const r = await submitFeedback(raw, clientIp(req));
    if (r.ok) return Response.json({ ok: true });
    if (r.status === 400) return jsonError(400, "Please check the highlighted fields.", { fieldErrors: r.fieldErrors });
    return Response.json({ error: "Too many submissions. Please try again later." }, { status: 429, headers: { "Retry-After": String(r.retryAfter) } });
  } catch (err) {
    console.error("feedback submit failed", err instanceof Error ? err.message : String(err));
    return jsonError(500, "Something went wrong. Please try again.");
  }
}
