import { requireOperator } from "@/server/http";
import { listFeedbackInvites, listFeedbackResponses } from "@/server/feedback";

export async function GET() {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const [responses, invites] = await Promise.all([listFeedbackResponses(), listFeedbackInvites()]);
  return Response.json({ responses, invites }, { headers: { "Cache-Control": "no-store" } });
}
