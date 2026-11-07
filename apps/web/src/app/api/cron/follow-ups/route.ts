import { requireCronAuth } from "../_auth";
import { runFollowUps } from "@/server/follow-ups";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Sends once-only follow-up emails: clarification nudges, quote reminders, monitoring pitches, expert reminders. */
export async function GET(request: Request) {
  const denied = requireCronAuth(request);
  if (denied) return denied;
  try {
    const result = await runFollowUps();
    return Response.json(result);
  } catch (err) {
    console.error("follow-ups cron failed", err instanceof Error ? err.message : err);
    return Response.json({ error: "follow-ups run failed" }, { status: 500 });
  }
}
