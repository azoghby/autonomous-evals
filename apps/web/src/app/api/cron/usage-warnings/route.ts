import { createDbUsageWarningDeps, sendUsageWarnings } from "@ae/core/payments/usage-warnings";
import { alertOperators } from "@/server/operator-alerts";
import { requireCronAuth } from "../_auth";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Emails account owners once per month per threshold (80% and 100% of included trials). Idempotent via the
 * usage_warnings unique marker; runs several times a day so a threshold crossed mid-month is caught promptly.
 */
export async function GET(request: Request) {
  const denied = requireCronAuth(request);
  if (denied) return denied;
  try {
    const origin = (process.env.APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
    const summary = await sendUsageWarnings({ origin }, createDbUsageWarningDeps());
    if (summary.failed > 0) {
      await alertOperators({
        kind: "usage_warnings_failed",
        title: `Usage warning emails: ${summary.failed} of ${summary.considered} failed`,
        detail: summary.errors.slice(0, 3).join("; "),
        severity: "warning",
      });
    }
    return Response.json(summary);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    console.error("usage warnings cron failed", detail);
    return Response.json({ error: "usage warnings failed" }, { status: 500 });
  }
}
