import { requireOperator } from "@/server/http";
import { listRecentSalesLeads } from "@/server/sales-leads";

export async function GET() {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  return Response.json({ leads: await listRecentSalesLeads() }, { headers: { "Cache-Control": "no-store" } });
}
