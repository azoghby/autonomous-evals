import { requireCronAuth } from "../_auth";
import { runMonitoring } from "../../../../server/monitoring";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Nightly: re-runs each active subscription's frozen suite and emails the customer on regressions. */
export async function GET(request: Request) {
  const denied = requireCronAuth(request);
  if (denied) return denied;
  try {
    return Response.json(await runMonitoring());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
