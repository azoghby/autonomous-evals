"use client";
import type { ReactNode } from "react";
import { MotionConfig, motion } from "motion/react";
import { EASE } from "@/components/app/motion";

/** Re-mounts on every navigation, giving each app screen a soft enter. */
export default function AppTemplate({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }}>
        {children}
      </motion.div>
    </MotionConfig>
  );
}
