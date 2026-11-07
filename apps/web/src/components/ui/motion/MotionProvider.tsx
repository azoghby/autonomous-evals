"use client";
import { LazyMotion } from "motion/react";
import type { ReactNode } from "react";

/** Load motion's animation features (incl. layout) after hydration instead of in the initial bundle. */
const loadFeatures = () => import("./features").then((mod) => mod.default);

export function MotionProvider({ children }: { children: ReactNode }) {
  return <LazyMotion features={loadFeatures}>{children}</LazyMotion>;
}
