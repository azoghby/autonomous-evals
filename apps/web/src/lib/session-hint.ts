/**
 * A non-HttpOnly "signed in" hint next to the HttpOnly session cookie. It carries no credential: it only lets
 * client UI (the command palette) skip authenticated requests for signed-out visitors. The server still enforces auth.
 */
export const SESSION_HINT_COOKIE = "ae_in";

const HINT_MAX_AGE_SEC = 60 * 60 * 24 * 30;

/** True when a `document.cookie`-style string carries the hint. */
export function hasSessionHint(cookieString: string): boolean {
  return cookieString.split(";").some((part) => part.trim() === `${SESSION_HINT_COOKIE}=1`);
}

/** Cookie attributes shared by every writer so set and clear always target the same cookie. */
export const sessionHintAttrs = (secure: boolean): string => `Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;

/** Browser-only: set or clear the hint. */
export function writeSessionHint(signedIn: boolean): void {
  if (typeof document === "undefined") return;
  const attrs = sessionHintAttrs(location.protocol === "https:");
  document.cookie = signedIn
    ? `${SESSION_HINT_COOKIE}=1; ${attrs}; Max-Age=${HINT_MAX_AGE_SEC}`
    : `${SESSION_HINT_COOKIE}=; ${attrs}; Max-Age=0`;
}
