import "server-only";
import { requireCronAuth } from "@/app/api/cron/_auth";
import type { RunResult } from "./runtime";

/** Wraps a company agent entry point as a CRON_SECRET-protected GET handler. */
export function companyCronHandler(name: string, run: () => Promise<RunResult>) {
  return async function GET(request: Request): Promise<Response> {
    const denied = requireCronAuth(request);
    if (denied) return denied;
    try {
      const result = await run();
      return Response.json(result);
    } catch (err) {
      console.error(`${name} cron failed`, err instanceof Error ? err.message : err);
      return Response.json({ error: `${name} run failed` }, { status: 500 });
    }
  };
}
