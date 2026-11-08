import { z } from "zod";
import { MAX_CUSTOMER_TEXT_CHARS } from "@ae/core/company/onboarding";
import { jsonError, readJson, requireViewer } from "@/server/http";
import { clientIp, rateLimit } from "@/server/rate-limit";
import { handleOnboardingMessage, skipReason } from "@/server/company/onboarding";
import { drizzleOnboardingStore } from "@/server/company/onboarding-store";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Body = z.object({
  message: z.string().trim().min(1).max(MAX_CUSTOMER_TEXT_CHARS),
  conversationId: z.uuid().optional(),
});

const tooMany = (retryAfter: number) =>
  Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });

export async function POST(req: Request) {
  const ipLimit = await rateLimit(`sandbox-assistant-ip:${clientIp(req)}`, 60, 3600);
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfter);
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const userLimit = await rateLimit(`sandbox-assistant:${auth.viewer.id}`, 40, 3600);
  if (!userLimit.ok) return tooMany(userLimit.retryAfter);
  const body = await readJson(req, Body);
  if (!body.ok) return body.res;
  try {
    const out = await handleOnboardingMessage({ customerId: auth.viewer.id, channel: "chat", text: body.data.message, conversationId: body.data.conversationId });
    const skipped = skipReason(out.result);
    if (skipped === "disabled") return jsonError(503, "The onboarding assistant is off right now.");
    if (skipped === "daily_budget_exhausted") return jsonError(503, "The onboarding assistant is resting for today. Please try again tomorrow.");
    if (!out.conversationId) return jsonError(skipped ? 429 : 500, out.reply || "Could not process that message.");
    return Response.json({ reply: out.reply, conversationId: out.conversationId, status: out.status });
  } catch (err) {
    console.error("sandbox assistant failed", err instanceof Error ? err.message : err);
    return jsonError(500, "Could not process that message.");
  }
}

/** Latest chat conversation for the signed-in customer (transcript includes the report once the run finishes). */
export async function GET() {
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const conv = await drizzleOnboardingStore().latestForCustomer(auth.viewer.id, "chat");
  if (!conv) return Response.json({ conversationId: null, status: "collecting", transcript: [] });
  return Response.json({ conversationId: conv.id, status: conv.status, transcript: conv.transcript.map((t) => ({ role: t.role, text: t.text, at: t.at })) });
}
