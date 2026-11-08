import { jsonError } from "@/server/http";
import { getCurrentCustomer } from "@/server/queries";
import { getInfraReport } from "@/server/infra";

export const dynamic = "force-dynamic";

export async function GET() {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  if (!me.isOperator) return jsonError(403, "Operator access required");
  return Response.json(await getInfraReport(), { headers: { "Cache-Control": "no-store" } });
}
