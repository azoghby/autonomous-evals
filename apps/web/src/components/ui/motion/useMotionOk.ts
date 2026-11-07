"use client";
import { useReducedMotion } from "motion/react";

/** True when transform-based motion is allowed (user has NOT asked for reduced motion). */
export function useMotionOk(): boolean {
  return !useReducedMotion();
}

/** Opacity-only fades at <= 0.2s are the reduced-motion fallback. */
export function useMotionDuration(full: number): number {
  return useReducedMotion() ? Math.min(full, 0.2) : full;
}
