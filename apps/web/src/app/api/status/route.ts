import { getStatusSummary } from "@/server/status";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const summary = await getStatusSummary();
  return Response.json(summary, {
    status: summary.overall.level === "down" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
