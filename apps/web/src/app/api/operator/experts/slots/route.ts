import { jsonError, readJson, requireOperator } from "@/server/http";
import { ExpertError } from "@/server/experts";
import { addSlots, listAllSlots } from "@/server/expert-calls";
import { SlotsBody } from "@/server/expert-calls-logic";

export async function GET() {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  return Response.json({ slots: await listAllSlots() }, { headers: { "Cache-Control": "no-store" } });
}

/** Body: {startsAt, durationMin?} or {slots: [{startsAt, durationMin?}, ...]} (max 100). */
export async function POST(req: Request) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const body = await readJson(req, SlotsBody);
  if (!body.ok) return body.res;
  try {
    return Response.json(await addSlots(body.data), { status: 201 });
  } catch (err) {
    if (err instanceof ExpertError) return jsonError(err.status, err.message);
    throw err;
  }
}
