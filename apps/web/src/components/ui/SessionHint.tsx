"use client";
import { useEffect } from "react";
import { writeSessionHint } from "@/lib/session-hint";

/** Mounted by the server-rendered app layout, which knows the real session: keeps the client-side hint in sync. */
export function SessionHint({ signedIn }: { signedIn: boolean }) {
  useEffect(() => writeSessionHint(signedIn), [signedIn]);
  return null;
}
