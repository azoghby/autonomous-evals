import { z } from "zod";
import { jsonError } from "@/server/http";
import { rateLimit, clientIp } from "@/server/rate-limit";
import { verifySubmission } from "@/server/owner-submit";

const Body = z.object({ token: z.string().min(16).max(200) });

/** POST only: a GET (link scanners prefetch emailed links) never verifies. */
export async function POST(req: Request) {
  const rl = await rateLimit(`agent-verify:ip:${clientIp(req)}`, 20, 3600);
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  let raw: unknown;
  try { raw = await req.json(); } catch { return jsonError(400, "Invalid JSON body"); }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return jsonError(400, "Invalid link");
  try {
    const r = await verifySubmission(parsed.data.token);
    if (r.status === "ok") return Response.json(r, { status: 200 });
    if (r.status === "invalid") return jsonError(400, "This link is not valid.");
    return jsonError(410, r.status === "used" ? "This link was already used." : "This link has expired. Submit your agent again to get a new one.", { status: r.status });
  } catch (err) {
    console.error("agent verify failed", err instanceof Error ? err.message : "unknown");
    return jsonError(500, "Could not confirm. Please try again.");
  }
}
