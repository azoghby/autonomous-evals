"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

const REFRESH_MS = 5_000;

/** Re-runs the server component every few seconds while a run is unfinished. Renders nothing. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [active, router]);
  return null;
}
