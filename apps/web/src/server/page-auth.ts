import "server-only";
import { redirect } from "next/navigation";
import { safeNextPath } from "@ae/core/auth/tokens";
import { getCurrentCustomer } from "./queries";

/** /signin?next=<path> for a same-site path (anything else falls back to the default next). */
export function signinRedirectPath(next: string): string {
  return `/signin?next=${encodeURIComponent(safeNextPath(next))}`;
}

/** Thrown when the session cannot be checked (DB down): renders the app error state instead of a sign-in redirect. */
export class SessionUnavailableError extends Error {
  override name = "SessionUnavailableError";
  constructor(cause: unknown) {
    super("We couldn't verify your session right now. Please try again in a moment.", { cause });
  }
}

/**
 * Server-side gate for signed-in pages: anonymous visitors are redirected instead of seeing a client "Loading…" shell.
 * A lookup failure is not "signed out": it throws SessionUnavailableError so signed-in users see an error state
 * (app/error.tsx) rather than being bounced to /signin.
 */
export async function requireSignedInPage(next: string) {
  let me: Awaited<ReturnType<typeof getCurrentCustomer>>;
  try {
    me = await getCurrentCustomer();
  } catch (err) {
    console.error("session lookup failed", err instanceof Error ? err.name : "unknown");
    throw new SessionUnavailableError(err);
  }
  if (!me) redirect(signinRedirectPath(next));
  return me;
}
