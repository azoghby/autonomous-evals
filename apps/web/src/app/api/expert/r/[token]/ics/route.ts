import { jsonError } from "@/server/http";
import { ExpertError } from "@/server/experts";
import { getBookingIcs } from "@/server/expert-calls";

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  try {
    const ics = await getBookingIcs(token);
    return new Response(ics, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'attachment; filename="expert-call.ics"',
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ExpertError) return jsonError(err.status, err.message);
    console.error("expert ics failed", err);
    return jsonError(500, "Could not build the calendar file.");
  }
}
