import { z } from "zod";
import { ExpertSignup } from "@ae/core/contracts/experts";
import { jsonError } from "@/server/http";
import { createExpertFromSignup } from "@/server/experts";

/** Public opt-in signup. `hp` is a honeypot: bots fill it, humans never see it. */
export async function POST(req: Request) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return jsonError(400, "Invalid JSON body"); }
  if (raw && typeof raw === "object" && typeof (raw as { hp?: unknown }).hp === "string" && (raw as { hp: string }).hp.trim()) {
    return Response.json({ ok: true }, { status: 201 }); // pretend success, store nothing
  }
  const parsed = ExpertSignup.safeParse(raw);
  if (!parsed.success) return jsonError(400, "Invalid request", { issues: z.flattenError(parsed.error) });
  try {
    const r = await createExpertFromSignup(parsed.data, "opt_in");
    if (r.status === "suppressed") {
      return jsonError(409, "This address has asked not to be contacted, so we cannot add it. If that was a mistake, email us and we will sort it out.");
    }
    // Same response for new and existing so signup can't be used to probe who is in the pool.
    return Response.json({ ok: true }, { status: 201 });
  } catch (err) {
    console.error("expert signup failed", err);
    return jsonError(500, "Could not save your details. Please try again.");
  }
}
