import { hashToken } from "@ae/core/auth/tokens";
import { rateLimit } from "@/server/rate-limit";
import { jsonError, readJson } from "@/server/http";
import { ExpertError } from "@/server/experts";
import { bookSlot } from "@/server/expert-calls";
import { BookBody } from "@/server/expert-calls-logic";

/** Books (or reschedules to) a slot. recordingConsent is an explicit boolean from the form; never defaulted. */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const rl = await rateLimit(`expert-book:${hashToken(token)}`, 10, 600);
  if (!rl.ok) return jsonError(429, "Too many requests. Please try again later.", { retryAfter: rl.retryAfter });
  const body = await readJson(req, BookBody);
  if (!body.ok) return body.res;
  try {
    return Response.json(await bookSlot(token, body.data.slotId, body.data.recordingConsent), { status: 201 });
  } catch (err) {
    if (err instanceof ExpertError) return jsonError(err.status, err.message);
    console.error("expert book failed", err);
    return jsonError(500, "Could not book that time. Please try again.");
  }
}
