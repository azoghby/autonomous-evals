import { companyCronHandler } from "@/server/company/cron";
import { runPlannerWithDispatch } from "@/server/company/agents";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Daily plan + task dispatch to the other company agents (each keeps its own toggle and budget). */
export const GET = companyCronHandler("planner", () => runPlannerWithDispatch({ trigger: "cron" }));
