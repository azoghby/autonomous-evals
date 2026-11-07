import { requireCronAuth } from "../_auth";

export const dynamic = "force-dynamic";

/** Stub: will call Track B's monitoring functions once they land. */
export async function GET(request: Request) {
  const denied = requireCronAuth(request);
  if (denied) return denied;
  return Response.json({ skipped: true, reason: "Track B monitoring evaluation is not wired yet" });
}
