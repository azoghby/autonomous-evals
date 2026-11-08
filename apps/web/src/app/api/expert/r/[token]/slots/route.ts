import { jsonError } from "@/server/http";
import { ExpertError } from "@/server/experts";
import { listOpenSlots } from "@/server/expert-calls";

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  try {
    return Response.json(await listOpenSlots(token), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ExpertError) return jsonError(err.status, err.message);
    console.error("expert slots failed", err);
    return jsonError(500, "Could not load available times.");
  }
}
