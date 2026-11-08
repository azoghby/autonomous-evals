import { z } from "zod";
import { jsonError, readJson } from "@/server/http";
import { verifySignedToken } from "@/server/owner-policy";
import { clientIp, rateLimit } from "@/server/rate-limit";
import { parseDecisionToken } from "@/server/notify/approvals-logic";
import { decideApproval } from "@/server/notify/approvals";

const Body = z.object({ t: z.string().min(1).max(4096) });

/** POST-only mutation for the email one-click links (the GET page only renders a confirm button). Idempotent. */
export async function POST(req: Request) {
  const rl = await rateLimit(`notify-decide:${clientIp(req)}`, 20, 3600);
  if (!rl.ok) return jsonError(429, "Too many attempts", { retryAfter: rl.retryAfter });
  const body = await readJson(req, Body);
  if (!body.ok) return body.res;
  const payload = parseDecisionToken(verifySignedToken("founder_decision", body.data.t));
  if (!payload) return jsonError(403, "Link is invalid or expired");
  const r = await decideApproval({ id: payload.aid, decision: payload.d, via: "email" });
  if (!r.ok && !r.changed && r.status === "not_found") return jsonError(404, r.message);
  return Response.json({ ok: r.ok, changed: r.changed, status: r.status, message: r.message });
}
