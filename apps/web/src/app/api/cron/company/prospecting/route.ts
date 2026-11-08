import { companyCronHandler } from "@/server/company/cron";
import { runProspectingAgent } from "@/server/company/prospecting";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = companyCronHandler("prospecting", () => runProspectingAgent({ trigger: "cron" }));
