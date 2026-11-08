import { companyCronHandler } from "@/server/company/cron";
import { runOnboardingFollowThrough } from "@/server/company/onboarding";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Starts runs for ready suites, and reports finished runs to the customers who asked. */
export const GET = companyCronHandler("onboarding", () => runOnboardingFollowThrough({ trigger: "cron" }));
