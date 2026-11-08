import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { customerForSessionToken } from "@ae/core/auth/magic-link";
import { isOperator } from "@ae/core/auth/tokens";
import type { Viewer } from "./access";

export const SESSION_COOKIE = "ae_session";

export const sessionCookieOptions = (expires: Date) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  expires,
});

export async function getSessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

/** Memoized per request: the layout, page and any server component share one session lookup. */
export const getCurrentCustomer = cache(async (): Promise<Viewer | null> => {
  const token = await getSessionToken();
  if (!token) return null;
  const c = await customerForSessionToken(token);
  if (!c) return null;
  return { id: c.id, email: c.email, isOperator: isOperator(c.email) };
});
