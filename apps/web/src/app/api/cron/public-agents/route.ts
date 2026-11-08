import { requireCronAuth } from "../_auth";
import { runNextPublicAgent } from "@/server/public-agent-cron";

export const dynamic = "force-dynamic";
// A 32-scenario lite run finishes in a couple of minutes; the run itself times out at 4.5 min, inside this limit.
export const maxDuration = 300;

/** Runs the ONE most-overdue public agent against the frozen standard suite (see server/public-agent-cron.ts). */
export async function GET(request: Request) {
  const denied = requireCronAuth(request);
  if (denied) return denied;
  try {
    const result = await runNextPublicAgent(new Date(), (l) => console.log(l));
    return Response.json(result, { status: result.status === "failed" ? 500 : 200 });
  } catch (err) {
    console.error("public-agents cron failed", err instanceof Error ? err.message : err);
    return Response.json({ error: "public-agents run failed" }, { status: 500 });
  }
}
