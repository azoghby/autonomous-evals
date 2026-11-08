import { jsonError } from "@/server/http";
import { getCurrentCustomer } from "@/server/queries";
import { realtimeConfigured, realtimeUrl, sealOperatorLive } from "@/server/realtime";

/** Operator-only sealed live queries (recent jobs, payments, interventions). */
export async function GET() {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  if (!me.isOperator) return jsonError(403, "Operator access required");
  if (!realtimeConfigured()) return jsonError(503, "Realtime not configured");
  const sealed = await sealOperatorLive();
  return Response.json({ url: realtimeUrl(), ...sealed }, { headers: { "Cache-Control": "private, no-store" } });
}
