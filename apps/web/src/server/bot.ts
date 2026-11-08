import "server-only";
import { checkBotId } from "botid/server";

/**
 * Server-side BotID check. Returns a 403 Response for bots, or null for humans / good bots.
 * In development checkBotId() returns a human verdict, so local flows are unaffected.
 *
 *   const blocked = await assertHuman();
 *   if (blocked) return blocked;
 */
export async function assertHuman(): Promise<Response | null> {
  const verification = await checkBotId();
  if (verification.isBot && !verification.isVerifiedBot) {
    return Response.json({ error: "bot_detected" }, { status: 403 });
  }
  return null;
}
