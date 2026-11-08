import { z } from "zod";
import { EXPERT_MODES } from "@ae/core/contracts/experts";
import { jsonError, readJson, requireOperator } from "@/server/http";
import { ExpertError, inviteExpert } from "@/server/experts";

const Body = z.object({ requestId: z.uuid(), expertId: z.uuid(), mode: z.enum(EXPERT_MODES).default("async") });

/** Creates the engagement + a PENDING outreach draft. Sending still requires operator approval of the draft. */
export async function POST(req: Request) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const body = await readJson(req, Body);
  if (!body.ok) return body.res;
  try {
    const r = await inviteExpert(body.data.requestId, body.data.expertId, body.data.mode);
    return Response.json({ ...r, status: "draft_pending_approval" }, { status: 201 });
  } catch (err) {
    if (err instanceof ExpertError) return jsonError(err.status, err.message);
    throw err;
  }
}
