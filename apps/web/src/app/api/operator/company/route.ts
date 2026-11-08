import { jsonError, requireOperator } from "@/server/http";
import { getOperatorCompanyView } from "@/server/company/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  try {
    return Response.json(await getOperatorCompanyView(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("operator company view failed", err instanceof Error ? err.message : err);
    return jsonError(500, "Could not load company view");
  }
}
