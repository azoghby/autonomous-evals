import { destroySession } from "@ae/core/auth/magic-link";
import { getSessionToken, SESSION_COOKIE } from "@/server/session";
import { SESSION_HINT_COOKIE } from "@/lib/session-hint";
import { cookies } from "next/headers";

export async function POST() {
  const token = await getSessionToken();
  if (token) await destroySession(token);
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(SESSION_HINT_COOKIE);
  return Response.json({ ok: true });
}
