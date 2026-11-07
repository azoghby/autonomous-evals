import { randomBytes } from "node:crypto";

export const LIVE_PREFIX = "ae_live_";
export const TEST_PREFIX = "ae_test_";
export const DISPLAY_PREFIX_LEN = 12;

export function generateKeyString(live: boolean): string {
  return (live ? LIVE_PREFIX : TEST_PREFIX) + randomBytes(32).toString("base64url");
}

/** Returns the key mode, or null when the string is not a well-formed API key. */
export function parseKeyFormat(key: string | undefined | null): "live" | "test" | null {
  if (typeof key !== "string") return null;
  const m = /^ae_(live|test)_[A-Za-z0-9_-]{43}$/.exec(key);
  return m ? (m[1] as "live" | "test") : null;
}

export const keyDisplayPrefix = (key: string) => key.slice(0, DISPLAY_PREFIX_LEN);
