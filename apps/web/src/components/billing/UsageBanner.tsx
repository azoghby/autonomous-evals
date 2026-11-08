import Link from "next/link";
import type { UsageSummary } from "@/server/billing-usage";
import { overageNotice } from "@/server/billing-usage";

/** Server-rendered banner shown only when the customer is near or at a plan limit. */
export function UsageBanner({ summary }: { summary: UsageSummary }) {
  if (summary.status === "ok") return null;
  const atLimit = summary.status === "at_limit";
  const paid = summary.plan !== "developer";
  const headline = atLimit
    ? paid ? `You are past your included usage. ${overageNotice()}` : "You have reached your plan limit. New runs are paused until it resets or you upgrade."
    : "You are close to your plan limit.";
  return (
    <div className="bill-banner" data-state={summary.status} role={atLimit ? "alert" : "status"}>
      <p className="text-[14px] text-fg">
        <strong className="font-medium">{summary.planName} plan.</strong> {headline}
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[14px]">
        <Link className="underline" href="/settings/billing">View usage</Link>
        {summary.upgrade ? <Link className="underline" href="/pricing">Upgrade to {summary.upgrade.targetPlan}</Link> : null}
      </div>
    </div>
  );
}
