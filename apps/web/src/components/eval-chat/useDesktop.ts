"use client";
import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 1024px)";
const subscribe = (cb: () => void) => {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** True at >= 1024px. Server snapshot is desktop; it corrects right after hydration on small screens. */
export const useDesktop = (): boolean => useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => true);
