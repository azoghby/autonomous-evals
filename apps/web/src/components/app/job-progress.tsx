"use client";
import type { JobState } from "@ae/core/contracts/index";
import { when } from "@/lib/client/api";
import type { ProgressItem } from "@/lib/client/types";
import { Glass, Spinner } from "./ui";

export function ProgressTimeline({ progress, state }: { progress: ProgressItem[]; state: JobState }) {
  return (
    <Glass>
      <div className="mb-4 flex items-center gap-3">
        <Spinner size={16} />
        <h2 className="text-lg font-semibold">Work in progress ({state})</h2>
      </div>
      {progress.length === 0 ? (
        <p className="text-sm text-cream/70">Starting up. Milestones will appear here as they happen.</p>
      ) : (
        <ol className="relative space-y-4 border-l border-glass-border pl-5" aria-live="polite">
          {progress.map((p, i) => (
            <li key={`${p.createdAt}-${i}`} className="relative">
              <span className={`absolute -left-[27px] top-1.5 h-3 w-3 rounded-full border-2 border-navy-deep ${i === progress.length - 1 ? "bg-coral" : "bg-cream/60"}`} />
              <div className="text-sm font-medium">{p.message}</div>
              <div className="text-xs text-cream/50">{p.milestone} · {when(p.createdAt)}</div>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-4 text-xs text-cream/50">You can close this tab; your report will be waiting when you come back.</p>
    </Glass>
  );
}
