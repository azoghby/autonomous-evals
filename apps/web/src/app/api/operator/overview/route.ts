import { jsonError } from "@/server/http";
import { getOperatorOverview, getCurrentCustomer } from "@/server/queries";

export async function GET() {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  if (!me.isOperator) return jsonError(403, "Operator access required");
  const data = await getOperatorOverview();
  return data ? Response.json(data, { headers: { "Cache-Control": "no-store" } }) : jsonError(403, "Operator access required");
}
