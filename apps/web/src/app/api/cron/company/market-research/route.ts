import { companyCronHandler } from "@/server/company/cron";
import { runMarketResearchAgent } from "@/server/company/market-research";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = companyCronHandler("market_research", () => runMarketResearchAgent({ trigger: "cron" }));
