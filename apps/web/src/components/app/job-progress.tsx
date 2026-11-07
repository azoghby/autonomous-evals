"use client";
import { motion, useReducedMotion } from "motion/react";
import type { JobState } from "@ae/core/contracts/index";
import { when } from "@/lib/client/api";
import type { ProgressItem } from "@/lib/client/types";
import { EASE } from "./motion";
import { Panel } from "./page-parts";

const labelOf = (s: JobState) => s.replace(/_/g, " ");

export function ProgressTimeline({ progress, state }: { progress: ProgressItem[]; state: JobState }) {
  const reduce = useReducedMotion();
  return (
    <Panel title={`Work in progress · ${labelOf(state)}`} aside={progress.length > 0 ? (
      <span className="t-data inline-flex items-center gap-2 text-subtle">
        <span aria-hidden className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
        <span className="tabular-nums">{progress.length} step{progress.length === 1 ? "" : "s"}</span> · live
      </span>
    ) : undefined}>
      {progress.length === 0 ? (
        <p className="text-[15px] text-muted">Starting up. Milestones will appear here as they happen.</p>
      ) : (
        <ol className="m-0 list-none p-0" aria-live="polite">
          {progress.map((p, i) => {
            const current = i === progress.length - 1;
            return (
              <motion.li key={`${p.createdAt}-${i}`} className="relative pb-6 pl-8 last:pb-0"
                initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE }}>
                {!current && <span aria-hidden className="absolute bottom-0 left-[4.5px] top-[18px] w-px bg-line-3" />}
                <span aria-hidden className="absolute left-0 top-[7px] flex size-[10px] items-center justify-center">
                  {current && <span className="absolute size-[10px] rounded-full bg-accent opacity-50 motion-safe:animate-ping" />}
                  <span className={`relative size-[10px] rounded-full border ${current ? "border-accent bg-accent" : "border-line-3 bg-bg-raised"}`} />
                </span>
                <div className={`text-[15px] leading-6 ${current ? "text-fg" : "text-muted"}`}>{p.message}</div>
                <div className="t-data mt-1 text-subtle">{p.milestone.replace(/_/g, " ")} · {when(p.createdAt)}</div>
              </motion.li>
            );
          })}
        </ol>
      )}
      <p className="mt-8 border-t border-line pt-4 text-xs text-subtle">You can close this tab; your report will be waiting when you come back.</p>
    </Panel>
  );
}
