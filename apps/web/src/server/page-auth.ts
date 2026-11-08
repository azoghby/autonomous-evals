import "server-only";
import { redirect } from "next/navigation";
import { safeNextPath } from "@ae/core/auth/tokens";
import { getCurrentCustomer } from "./queries";

/** /signin?next=<path> for a same-site path (anything else falls back to the default next). */
export function signinRedirectPath(next: string): string {
  return `/signin?next=${encodeURIComponent(safeNextPath(next))}`;
}

/** Server-side gate for signed-in pages: anonymous visitors are redirected instead of seeing a client "Loading…" shell. */
export async function requireSignedInPage(next: string) {
  const me = await getCurrentCustomer().catch(() => null);
  if (!me) redirect(signinRedirectPath(next));
  return me;
}
