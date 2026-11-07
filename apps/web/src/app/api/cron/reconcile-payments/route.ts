import { requireCronAuth } from "../_auth";
import { reconcilePayments } from "../../../../workflows/resume";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireCronAuth(request);
  if (denied) return denied;
  try {
    const summary = await reconcilePayments();
    return Response.json(summary, { status: summary.errors.length ? 500 : 200 });
  } catch (err) {
    console.error("reconcile-payments failed", err instanceof Error ? err.message : err);
    return Response.json({ error: "reconcile failed" }, { status: 500 });
  }
}
