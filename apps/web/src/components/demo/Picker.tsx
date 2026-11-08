"use client";

import { Chip } from "@/components/ui";
import type { DemoScenario } from "./demo-run-types";
import { roleLabel, scenarioPassSummary, str } from "./format";

export function Picker({
  scenarios,
  scenarioIndex,
  trialIndex,
  onScenario,
  onTrial,
}: {
  scenarios: DemoScenario[];
  scenarioIndex: number;
  trialIndex: number;
  onScenario: (i: number) => void;
  onTrial: (i: number) => void;
}) {
  const sc = scenarios[scenarioIndex];
  const trials = sc.trials ?? [];
  const faults = Array.isArray(sc.faults) ? sc.faults : [];
  const knowledge = Array.isArray(sc.persona?.knowledge) ? sc.persona.knowledge : [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="t-eyebrow mb-3 text-muted">Scenario</h2>
        <div className="flex flex-col gap-2" role="group" aria-label="Scenario">
          {scenarios.map((s, i) => {
            const active = i === scenarioIndex;
            const sum = scenarioPassSummary(s);
            return (
              <button
                key={s.id ?? i}
                type="button"
                aria-pressed={active}
                onClick={() => onScenario(i)}
                className={`rounded-[4px] border px-3.5 py-3 text-left transition-colors ${
                  active ? "border-accent bg-accent-soft" : "border-line-2 bg-bg-raised hover:border-line-3 hover:bg-bg-hover"
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className={`t-eyebrow ${active ? "text-accent-text" : "text-muted"}`}>{roleLabel(s.storyRole)}</span>
                  <Chip tone={sum.tone}>{sum.label}</Chip>
                </span>
                <span className="mt-2 block break-words text-[14px] leading-[1.4] text-fg [overflow-wrap:anywhere]">{str(s.title)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <h2 className="t-eyebrow mb-3 text-muted">Trial</h2>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Trial">
          {trials.map((t, i) => (
            <button
              key={i}
              type="button"
              aria-pressed={i === trialIndex}
              aria-label={`Trial ${i + 1}`}
              onClick={() => onTrial(i)}
              className={`t-data h-9 min-w-9 rounded-[4px] border px-3 transition-colors ${
                i === trialIndex ? "border-accent bg-accent-soft text-fg" : "border-line-2 text-muted hover:border-line-3 hover:text-fg"
              }`}
            >
              {i + 1}
            </button>
          ))}
          <span className="t-data self-center text-subtle">of {sc.k ?? trials.length}</span>
        </div>
      </div>

      <div>
        <h2 className="t-eyebrow mb-3 text-muted">Simulated customer</h2>
        <p className="break-words text-[14px] leading-[1.5] text-fg-2 [overflow-wrap:anywhere]">{str(sc.persona?.goal)}</p>
        <p className="mt-2 break-words text-[13px] text-muted [overflow-wrap:anywhere]">
          <span className="text-subtle">Style </span>{str(sc.persona?.style).replace(/^traits:[^;]*;\s*/i, "")}
        </p>
        {knowledge.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1 text-[13px] text-muted">
            {knowledge.map((k, i) => <li key={i} className="break-words [overflow-wrap:anywhere]">· {str(k)}</li>)}
          </ul>
        ) : null}
      </div>

      {faults.length > 0 ? (
        <div>
          <h2 className="t-eyebrow mb-3 text-muted">Injected faults</h2>
          <ul className="flex flex-col gap-2">
            {faults.map((f, i) => (
              <li key={i} className="t-data break-all rounded-[2px] border border-danger/40 px-2.5 py-2 text-danger">
                {str(f.fault)}
                <span className="block text-subtle">on {str(f.tool)} · call #{str(f.onCall)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
