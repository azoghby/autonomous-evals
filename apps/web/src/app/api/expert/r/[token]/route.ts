import { QuestionnaireAnswers } from "@ae/core/contracts/experts";
import { jsonError, readJson } from "@/server/http";
import { getQuestionnaire, submitAnswers } from "@/server/experts";

const GONE = { not_found: [404, "This link is not valid."], expired: [410, "This link has expired."],
  used: [409, "These answers were already submitted."], cancelled: [410, "This invitation was cancelled."] } as const;

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const r = await getQuestionnaire(token);
  if (r.check !== "ok") { const [s, m] = GONE[r.check]; return jsonError(s, m, { reason: r.check }); }
  return Response.json(r.questionnaire, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const body = await readJson(req, QuestionnaireAnswers);
  if (!body.ok) return body.res;
  try {
    const r = await submitAnswers(token, body.data.answers);
    return r.ok ? Response.json({ ok: true }, { status: 201 }) : jsonError(r.status, r.error);
  } catch (err) {
    console.error("expert submit failed", err);
    return jsonError(500, "Could not save your answers. Please try again.");
  }
}
