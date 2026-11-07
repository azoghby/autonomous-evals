"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { animate } from "animejs";
import type { JobState } from "@ae/core/contracts/index";
import { when } from "@/lib/client/api";
import type { ProgressItem } from "@/lib/client/types";
import { Block } from "./ui";
import { EASE } from "./motion";

const labelOf = (s: JobState) => s.replace(/_/g, " ");

export function ProgressTimeline({ progress, state }: { progress: ProgressItem[]; state: JobState }) {
  const reduce = useReducedMotion();
  const listRef = useRef<HTMLOListElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const prevH = useRef(0);

  // The rail draws down (anime.js scaleY, compositor-only) from where it previously ended to the newest milestone.
  useLayoutEffect(() => {
    const list = listRef.current;
    const line = lineRef.current;
    if (!list || !line) return;
    const h = Math.max(0, list.offsetHeight - 14);
    const from = h > 0 ? Math.min(1, prevH.current / h) : 0;
    prevH.current = h;
    line.style.height = `${h}px`;
    if (reduce || progress.length < 2) { line.style.transform = `scaleY(${progress.length < 2 ? 0 : 1})`; return; }
    const a = animate(line, { scaleY: [from, 1], duration: 900, ease: "outExpo" });
    return () => { a.pause(); };
  }, [progress.length, reduce]);

  useEffect(() => () => { prevH.current = 0; }, []);

  return (
    <Block title={`Work in progress · ${labelOf(state)}`}>
      {progress.length === 0 ? (
        <p className="text-sm text-muted">Starting up. Milestones will appear here as they happen.</p>
      ) : (
        <ol ref={listRef} className="relative space-y-6 pl-7" aria-live="polite">
          <span ref={lineRef} aria-hidden className="absolute left-[4.5px] top-2 w-px origin-top bg-line-strong" style={{ transform: "scaleY(0)" }} />
          <AnimatePresence initial={false}>
            {progress.map((p, i) => {
              const current = i === progress.length - 1;
              return (
                <motion.li key={`${p.createdAt}-${i}`} className="relative"
                  initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
                  <span className="absolute -left-7 top-1.5 flex h-[10px] w-[10px] items-center justify-center">
                    {current && !reduce && (
                      <motion.span aria-hidden className="absolute h-[10px] w-[10px] rounded-full bg-accent"
                        animate={{ scale: [1, 2.6], opacity: [0.5, 0] }} transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }} />
                    )}
                    <span className={`relative h-[10px] w-[10px] rounded-full ${current ? "bg-accent" : "bg-subtle"}`} />
                  </span>
                  <div className={`text-sm ${current ? "font-medium text-fg" : "text-muted"}`}>{p.message}</div>
                  <div className="mt-0.5 text-xs text-subtle">{p.milestone.replace(/_/g, " ")} · {when(p.createdAt)}</div>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>
      )}
      <p className="mt-8 text-xs text-subtle">You can close this tab; your report will be waiting when you come back.</p>
    </Block>
  );
}
