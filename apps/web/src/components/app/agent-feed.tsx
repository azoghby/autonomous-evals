"use client";
import type { ProgressItem } from "@/lib/client/types";
import { Panel } from "./page-parts";

const AGENT_BY_MILESTONE: Record<string, string> = {
  qualified: "Commercial", quoted: "Commercial",
  planning: "Evaluation engineer", designing: "Evaluation engineer",
  running: "Runner", auditing: "Runner",
  investigating: "Quality investigator", proposing_fix: "Quality investigator",
  delivered: "Operator", notified: "Operator",
};

export const agentFor = (milestone: string): string => AGENT_BY_MILESTONE[milestone] ?? "System";

const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
};

/** Agent-by-agent log of progress milestones. No cost meter: the job payload carries no per-job cost data. */
export function AgentFeed({ progress }: { progress: ProgressItem[] }) {
  if (progress.length === 0) return null;
  return (
    <Panel title="Agent activity" aside={<span className="t-data text-subtle tabular-nums">{progress.length} event{progress.length === 1 ? "" : "s"}</span>}>
      <ol className="m-0 list-none divide-y divide-line p-0 t-data" aria-label="Agent activity log">
        {[...progress].reverse().map((p, i) => (
          <li key={`${p.createdAt}-${p.milestone}-${i}`} className="grid grid-cols-[64px_1fr] gap-x-4 gap-y-0.5 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[72px_160px_1fr]">
            <time dateTime={p.createdAt} className="text-subtle tabular-nums">{time(p.createdAt)}</time>
            <span className="uppercase text-accent-text">{agentFor(p.milestone)}</span>
            <span className="col-span-2 text-fg-2 sm:col-span-1">{p.message}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
