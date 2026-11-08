import { jsonError, requireOperator } from "@/server/http";
import { getExpertsOverview } from "@/server/experts";

export async function GET() {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  try {
    return Response.json(await getExpertsOverview(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("experts overview failed", err);
    return jsonError(500, "Could not load experts");
  }
}
