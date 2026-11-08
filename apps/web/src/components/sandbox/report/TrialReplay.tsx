"use client";
import { useEffect, useMemo, useState } from "react";
import type { SandboxScenario, ScenarioResult } from "@ae/core/sandbox/spec";
import type { PolicyDoc } from "@ae/core/sandbox/spec";
import { CATEGORY_LABELS, type MediaPreview } from "../contract";
import { TrialDetail } from "./TrialDetail";

interface Props {
  scenarios: SandboxScenario[];
  results: ScenarioResult[];
  policies: PolicyDoc[];
  media: MediaPreview[];
}

const dot = (ok: boolean) => <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${ok ? "bg-ok" : "bg-danger"}`} />;

export function TrialReplay({ scenarios, results, policies, media }: Props) {
  const rows = useMemo(
    () => results.flatMap((r) => {
      const s = scenarios.find((x) => x.id === r.scenarioId);
      return s ? [{ s, r }] : [];
    }),
    [scenarios, results],
  );
  const firstFail = rows.find((x) => x.r.trials.some((t) => !t.passed));
  const [scenarioId, setScenarioId] = useState(firstFail?.s.id ?? rows[0]?.s.id ?? "");
  const [trialNo, setTrialNo] = useState<number | null>(firstFail ? (firstFail.r.trials.find((t) => !t.passed)?.trial ?? null) : null);

  useEffect(() => {
    const sync = () => {
      const id = decodeURIComponent(window.location.hash).replace(/^#replay-/, "");
      const hit = rows.find((x) => x.s.id === id);
      if (hit && window.location.hash.startsWith("#replay-")) {
        setScenarioId(hit.s.id);
        setTrialNo(hit.r.trials.find((t) => !t.passed)?.trial ?? null);
      }
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [rows]);

  const current = rows.find((x) => x.s.id === scenarioId);
  if (!current) return <p className="border-t border-line-2 py-8 text-[14px] text-muted">No trials to replay.</p>;
  const trial = current.r.trials.find((t) => t.trial === trialNo) ?? current.r.trials[0];
  const sMedia = media.filter((m) => m.scenarioId === current.s.id);

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <ul aria-label="Scenarios" className="min-w-0 divide-y divide-line border-y border-line-2 lg:max-h-[640px] lg:overflow-y-auto">
        {rows.map(({ s, r }) => (
          <li key={s.id} id={`replay-${s.id}`} className="scroll-mt-24">
            <button
              type="button"
              aria-pressed={s.id === scenarioId}
              onClick={() => { setScenarioId(s.id); setTrialNo(r.trials.find((t) => !t.passed)?.trial ?? null); }}
              className={`flex w-full items-start gap-2 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent ${s.id === scenarioId ? "bg-bg-raised text-fg" : "text-fg-2"}`}
            >
              <span className="mt-1.5">{dot(r.reliable)}</span>
              <span className="min-w-0">
                <span className="block break-words">{s.title}</span>
                <span className="font-mono text-[11px] uppercase text-subtle">{CATEGORY_LABELS[s.category]} · {r.trials.filter((t) => t.passed).length}/{r.trials.length}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0">
        <h3 className="break-words text-[18px] text-fg">{current.s.title}</h3>
        <p className="mt-1 text-[13px] text-muted">
          {CATEGORY_LABELS[current.s.category]} · persona <span className="text-fg-2">{current.s.persona.name}</span>{current.s.persona.adversarial ? " (adversarial)" : ""}: {current.s.persona.goal}
        </p>
        <div role="group" aria-label="Trials" className="mt-4 flex flex-wrap gap-2">
          {current.r.trials.map((t) => (
            <button
              key={t.trial}
              type="button"
              aria-pressed={t.trial === trial.trial}
              onClick={() => setTrialNo(t.trial)}
              className={`inline-flex h-8 items-center gap-2 rounded-[4px] border px-3 font-mono text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-accent ${t.trial === trial.trial ? "border-accent bg-accent-soft text-fg" : "border-line-2 text-fg-2 hover:bg-bg-hover"}`}
            >
              {dot(t.passed)} Trial {t.trial}<span className="sr-only">{t.passed ? " passed" : " failed"}</span>
            </button>
          ))}
        </div>
        <div className="mt-6">
          <TrialDetail trial={trial} media={sMedia} policies={policies} />
        </div>
      </div>
    </div>
  );
}
