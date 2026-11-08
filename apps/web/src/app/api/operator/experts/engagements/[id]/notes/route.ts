import { isUuid, jsonError, readJson, requireOperator } from "@/server/http";
import { ExpertError } from "@/server/experts";
import { addEngagementNotes } from "@/server/expert-calls";
import { NotesBody } from "@/server/expert-calls-logic";

/** Notes are always allowed; kind 'transcript' is refused (409) unless the engagement has recording_consent. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError(404, "Engagement not found");
  const body = await readJson(req, NotesBody);
  if (!body.ok) return body.res;
  try {
    return Response.json(await addEngagementNotes(id, body.data), { status: 201 });
  } catch (err) {
    if (err instanceof ExpertError) return jsonError(err.status, err.message);
    throw err;
  }
}
