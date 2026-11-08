import { getCurrentCustomer } from "@/server/queries";
import { jsonError } from "@/server/http";
import { getUsageSummary } from "@/server/billing-usage";

export const dynamic = "force-dynamic";

/** Current-month usage and limit status for the signed-in customer. */
export async function GET(): Promise<Response> {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Sign in to continue", { signinUrl: "/signin?next=/settings/billing" });
  try {
    return Response.json(await getUsageSummary(me.id));
  } catch (err) {
    console.error("billing usage failed", err instanceof Error ? err.message : err);
    return jsonError(500, "Could not load usage. Please try again.");
  }
}
