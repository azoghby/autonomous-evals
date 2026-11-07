import { ExpertRequest } from "@ae/core/contracts/experts";
import { readJson, requireOperator } from "@/server/http";
import { createExpertRequest } from "@/server/experts";

export async function POST(req: Request) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const body = await readJson(req, ExpertRequest);
  if (!body.ok) return body.res;
  const request = await createExpertRequest(body.data);
  return Response.json({ request }, { status: 201 });
}
