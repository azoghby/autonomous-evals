import { requireCronAuth } from "../_auth";
import { alertOperators } from "../../../../server/operator-alerts";
import { reconcilePayments } from "../../../../workflows/resume";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireCronAuth(request);
  if (denied) return denied;
  try {
    const summary = await reconcilePayments();
    if (summary.needsReview > 0) {
      await alertOperators({ kind: "payment_review_reconcile", title: "Payments need manual review", detail: `${summary.needsReview} payment(s) flagged by the reconcile cron; check interventions.`, severity: "critical" });
    }
    return Response.json(summary, { status: summary.errors.length ? 500 : 200 });
  } catch (err) {
    console.error("reconcile-payments failed", err instanceof Error ? err.message : err);
    return Response.json({ error: "reconcile failed" }, { status: 500 });
  }
}
