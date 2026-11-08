import { destroySession } from "@ae/core/auth/magic-link";
import { getSessionToken, SESSION_COOKIE } from "@/server/session";
import { cookies } from "next/headers";

export async function POST() {
  const token = await getSessionToken();
  if (token) await destroySession(token);
  (await cookies()).delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
