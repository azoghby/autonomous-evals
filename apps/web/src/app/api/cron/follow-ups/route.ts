import { requireCronAuth } from "../_auth";

export const dynamic = "force-dynamic";

/** Stub: will call Track B's follow-ups functions once they land. */
export async function GET(request: Request) {
  const denied = requireCronAuth(request);
  if (denied) return denied;
  return Response.json({ skipped: true, reason: "Track B follow-up drafting is not wired yet" });
}
