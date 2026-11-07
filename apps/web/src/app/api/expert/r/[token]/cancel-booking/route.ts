import { jsonError } from "@/server/http";
import { ExpertError } from "@/server/experts";
import { cancelBooking } from "@/server/expert-calls";

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  try {
    return Response.json(await cancelBooking(token));
  } catch (err) {
    if (err instanceof ExpertError) return jsonError(err.status, err.message);
    console.error("expert cancel-booking failed", err);
    return jsonError(500, "Could not cancel. Please try again.");
  }
}
