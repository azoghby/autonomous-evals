import { jsonError } from "@/server/http";
import { optOut } from "@/server/experts";

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  try {
    const r = await optOut({ token });
    return r.ok ? Response.json({ ok: true }) : jsonError(404, r.error);
  } catch (err) {
    console.error("expert opt-out failed", err);
    return jsonError(500, "Could not process your opt-out. Please try again.");
  }
}
