import { requireCronAuth } from "../_auth";
import { runFounderDailyReport } from "@/server/notify/daily-report";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Daily founder report (15:00 UTC) to Telegram / WhatsApp / email; also expires stale approvals. Once per day. */
export async function GET(request: Request) {
  const denied = requireCronAuth(request);
  if (denied) return denied;
  try {
    return Response.json(await runFounderDailyReport());
  } catch (err) {
    console.error("founder report cron failed", err instanceof Error ? err.message : err);
    return Response.json({ error: "founder report failed" }, { status: 500 });
  }
}
