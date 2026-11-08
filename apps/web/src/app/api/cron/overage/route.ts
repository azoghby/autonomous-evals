import { billOverageForPeriod, createDbOverageDeps } from "@ae/core/payments/overage-billing";
import { previousUsagePeriod } from "@ae/core/pricing/overage";
import { alertOperators } from "@/server/operator-alerts";
import { requireCronAuth } from "../_auth";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Bills last UTC month's trial overage as Stripe (test mode) invoice items. Runs on the 1st and retries daily through
 * the 5th; fully idempotent (billed rows are skipped, retries reuse the Stripe idempotency key).
 */
export async function GET(request: Request) {
  const denied = requireCronAuth(request);
  if (denied) return denied;
  try {
    const now = new Date();
    const summary = await billOverageForPeriod({ period: previousUsagePeriod(now), now }, createDbOverageDeps());
    if (summary.failed > 0) {
      await alertOperators({
        kind: "overage_billing_failed",
        title: `Overage billing: ${summary.failed} of ${summary.considered} customers failed for ${summary.period}`,
        detail: summary.failures.slice(0, 3).map((f) => `${f.customerId}: ${f.error}`).join("; "),
        severity: "warning",
      });
    }
    return Response.json(summary);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    console.error("overage cron failed", detail);
    await alertOperators({ kind: "overage_billing_crashed", title: "Overage billing cron crashed", detail, severity: "critical" });
    return Response.json({ error: "overage billing failed" }, { status: 500 });
  }
}
