import { jsonError } from "@/server/http";
import { getCurrentCustomer } from "@/server/queries";
import { getRevenueMetrics } from "@/server/revenue-metrics";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  if (!me.isOperator) return jsonError(403, "Operator access required");
  return Response.json(await getRevenueMetrics(), { headers: { "Cache-Control": "no-store" } });
}
