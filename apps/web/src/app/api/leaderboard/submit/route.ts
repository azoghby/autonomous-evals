import { z } from "zod";
import { jsonError } from "@/server/http";
import { rateLimit, clientIp } from "@/server/rate-limit";
import { assertHuman } from "@/server/bot";
import { assertPublicTarget } from "@/server/target-url";
import { SubmitAgentInput, createPendingSubmission } from "@/server/owner-submit";
import { normalizeEmail } from "@ae/core/auth/tokens";
import { readBoundedJson } from "@/server/body-limit";

const OK = { ok: true, message: "Check your email to confirm" };
const limited = (retryAfter: number) =>
  Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });

/** Owner submission. Always answers 201 for valid input so it can't be used to probe addresses. */
export async function POST(req: Request) {
  const blocked = await assertHuman(); if (blocked) return blocked;
  const ip = clientIp(req);
  const byIp = await rateLimit(`agent-submit:ip:${ip}`, 5, 3600);
  if (!byIp.ok) return limited(byIp.retryAfter);
  let raw: unknown;
  { const b = await readBoundedJson(req); if (!b.ok) return b.res; raw = b.value; }
  if (raw && typeof raw === "object" && typeof (raw as { hp?: unknown }).hp === "string" && (raw as { hp: string }).hp.trim()) {
    return Response.json(OK, { status: 201 }); // honeypot: pretend success, store nothing
  }
  const parsed = SubmitAgentInput.safeParse(raw);
  if (!parsed.success) return jsonError(400, "Invalid request", { issues: z.flattenError(parsed.error) });
  const byEmail = await rateLimit(`agent-submit:email:${normalizeEmail(parsed.data.ownerEmail)}`, 3, 86400);
  if (!byEmail.ok) return limited(byEmail.retryAfter);
  const reason = await assertPublicTarget(parsed.data.endpointUrl);
  if (reason) return jsonError(400, `Endpoint not allowed: ${reason}`, { issues: { fieldErrors: { endpointUrl: [reason] } } });
  try {
    await createPendingSubmission(parsed.data, { ip });
    return Response.json(OK, { status: 201 });
  } catch (err) {
    console.error("agent submit failed", err instanceof Error ? err.message : "unknown");
    return jsonError(500, "Could not save your submission. Please try again.");
  }
}
