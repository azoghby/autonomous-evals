import { z } from "zod";
import { jsonError, readJson } from "@/server/http";
import { verifySignedToken } from "@/server/owner-policy";
import { clientIp, rateLimit } from "@/server/rate-limit";
import { approveAndSendDraft, parseApproveAll, type ApproveAllPayload } from "@/server/outreach-approve";

const Body = z.object({ t: z.string().min(1).max(4096) });
export async function POST(req: Request) {
  const rl = await rateLimit(`approve-all:${clientIp(req)}`, 10, 3600);
  if (!rl.ok) return jsonError(429, "Too many attempts", { retryAfter: rl.retryAfter });
  const body = await readJson(req, Body);
  if (!body.ok) return body.res;
  const parsed = parseApproveAll(verifySignedToken<ApproveAllPayload>("approve_all", body.data.t));
  if (!parsed) return jsonError(403, "Link is invalid, expired, or no longer authorized");

  const results: { id: string; ok: boolean; status: string; error?: string }[] = [];
  for (const id of parsed.ids) {
    const r = await approveAndSendDraft(id, parsed.op);
    results.push(r.ok ? { id, ok: true, status: r.status, ...(r.sendError ? { error: r.sendError } : {}) } : { id, ok: false, status: String(r.status), error: r.error });
  }
  return Response.json({
    ok: true, total: results.length,
    sent: results.filter((r) => r.ok && r.status === "sent").length,
    approved: results.filter((r) => r.ok && r.status === "approved").length,
    skipped: results.filter((r) => !r.ok).length,
    results,
  });
}
