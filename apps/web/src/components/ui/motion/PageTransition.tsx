"use client";
import { motion } from "motion/react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { motionTokens } from "./tokens";
import { useMotionDuration } from "./useMotionOk";

/**
 * Route-enter transition: re-keys on pathname and fades/rises the new page in.
 * Enter-only on purpose: App Router swaps the tree synchronously, so exit animations never get to run.
 * Mount it once in a layout (e.g. app/(app)/layout.tsx) around {children}.
 */
export function PageTransition({ children, className }: { children: ReactNode; className?: string }) {
  const pathname = usePathname();
  const dur = useMotionDuration(motionTokens.duration.normal);
  return (
    <motion.div
      key={pathname}
      data-reveal
      className={className}
      initial={{ opacity: 0, y: motionTokens.distance.sm }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: dur, ease: motionTokens.easing.smooth }}
    >
      {children}
    </motion.div>
  );
}
