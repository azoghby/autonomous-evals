"use client";

import { useState } from "react";
import type { DemoRecording, DemoRun } from "./demo-run-types";
import { DemoPlayer } from "./DemoPlayer";
import { pct, recordedDate, str, usd } from "./format";

/** Pretty model name from a gateway id: "anthropic/claude-sonnet-5.5" -> "Claude Sonnet 5.5". */
export function modelLabel(id: string): string {
  const name = id.replace(/^[^/]+\//, "");
  return name
    .split("-")
    .map((w) => (/^gpt$/i.test(w) ? "GPT" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/^GPT /, "GPT-");
}

interface AgentGroup { key: string; name: string; url: string; license: string; framework?: string; note: string; runs: DemoRun[] }

function groupRuns(runs: DemoRun[]): AgentGroup[] {
  const groups: AgentGroup[] = [];
  for (const run of runs) {
    const key = run.source?.key ?? run.env?.id ?? "agent";
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, name: run.source?.name ?? str(run.env?.name), url: run.source?.url ?? "", license: run.source?.license ?? "", framework: run.source?.framework, note: run.source?.note ?? "", runs: [] };
      groups.push(g);
    }
    g.runs.push(run);
  }
  return groups;
}

function Summary({ run }: { run: DemoRun }) {
  const s = run.summary;
  const items: Array<[string, string]> = [
    ["pass@1", `${pct(s?.passAt1)} (${pct(s?.passAt1Ci95?.[0])}–${pct(s?.passAt1Ci95?.[1])} CI)`],
    ["pass^k", pct(s?.passHatK)],
    ["Scenarios · trials", `${s?.scenarios ?? run.scenarios.length} · ${s?.trials ?? "?"}`],
    ["Run cost", usd(s?.totalCostUsd)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="t-eyebrow text-subtle">{k}</dt>
          <dd className="t-data mt-1.5 break-words text-[15px] text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const pill = (active: boolean) =>
  `rounded-[4px] border px-3 py-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
    active ? "border-accent bg-accent-soft text-fg" : "border-line-2 text-muted hover:border-line-3 hover:text-fg"
  }`;

export function DemoStage({ recording }: { recording: DemoRecording }) {
  const groups = groupRuns(recording.runs);
  const [gi, setGi] = useState(0);
  const [mi, setMi] = useState(0);
  const group = groups[gi] ?? groups[0];
  const run = group?.runs[mi] ?? group?.runs[0];
  if (!group || !run) return <p className="text-muted">No recorded run is available yet.</p>;

  return (
    <div className="flex flex-col gap-8">
      <section aria-label="Choose an agent and model" className="grid gap-6 border-y border-line py-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <p className="t-eyebrow mb-3 text-subtle">Agent · real open-source app</p>
          <div className="flex flex-col gap-2 sm:flex-row" role="group" aria-label="Agent">
            {groups.map((g, i) => (
              <button key={g.key} type="button" aria-pressed={i === gi} onClick={() => { setGi(i); setMi(0); }} className={`${pill(i === gi)} min-w-0 flex-1`}>
                <span className="block text-[14px] text-fg">{g.name}</span>
                <span className="t-data mt-0.5 block text-subtle">{[g.framework, g.license].filter(Boolean).join(" · ")}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="min-w-0">
          <p className="t-eyebrow mb-3 text-subtle">Model</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Model">
            {group.runs.map((r, i) => (
              <button key={r.agent.model} type="button" aria-pressed={i === mi} onClick={() => setMi(i)} className={pill(i === mi)}>
                <span className="block text-[14px]">{modelLabel(r.agent.model)}</span>
                <span className={`t-data mt-0.5 block ${r.summary.passHatK === 1 ? "text-ok" : "text-warn"}`}>pass^k {pct(r.summary.passHatK)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2 lg:col-span-2">
          <p className="max-w-[80ch] text-[14px] leading-[1.55] text-muted">
            {group.note}{" "}
            {group.url ? <a className="text-fg underline decoration-line-3 underline-offset-4 hover:decoration-fg" href={group.url} target="_blank" rel="noopener noreferrer">Source on GitHub</a> : null}
          </p>
          <p className="t-data text-subtle">
            Recorded live on {recordedDate(run.recordedAt)} · {str(run.agent.model)} via {str(run.agent.via) || "AI Gateway"} · real model output, replayed
          </p>
        </div>
        <div className="lg:col-span-2"><Summary run={run} /></div>
      </section>
      <DemoPlayer key={`${group.key}:${run.agent.model}`} run={run} />
    </div>
  );
}
