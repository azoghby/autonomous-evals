import { companyCronHandler } from "@/server/company/cron";
import { runOutreachAgent } from "@/server/company/outreach";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const GET = companyCronHandler("outreach", () => runOutreachAgent({ trigger: "cron" }));
