import { jsonError } from "@/server/http";
import { clientIp } from "@/server/rate-limit";
import { submitSalesLead } from "@/server/sales-leads";

const MAX_BODY_CHARS = 32_000;

/** Public enterprise lead capture. Returns { ok: true } | { error, fieldErrors? } with 400 / 429. */
export async function POST(req: Request) {
  const text = await req.text().catch(() => "");
  if (text.length > MAX_BODY_CHARS) return jsonError(400, "Request too large");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return jsonError(400, "Invalid JSON body"); }

  try {
    const r = await submitSalesLead(raw, clientIp(req));
    if (r.ok) return Response.json({ ok: true });
    if (r.status === 400) return jsonError(400, "Please check the highlighted fields.", { fieldErrors: r.fieldErrors });
    return Response.json({ error: "Too many requests. Please try again later." }, { status: 429, headers: { "Retry-After": String(r.retryAfter) } });
  } catch (err) {
    console.error("contact-sales failed", err instanceof Error ? err.message : String(err));
    return jsonError(500, "Something went wrong. Please try again.");
  }
}
