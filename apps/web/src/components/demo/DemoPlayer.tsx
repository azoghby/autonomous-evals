"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DemoRun, DemoScenario, DemoTrial } from "./demo-run-types";
import { Controls, type Speed } from "./Controls";
import { Conversation } from "./Conversation";
import { Picker } from "./Picker";
import { buildTimeline, snapshotAt } from "./replay";
import { StepRail } from "./StepRail";
import { Verdict } from "./Verdict";
import { World } from "./World";
import { str } from "./format";

const MAX_FRAME_DT_MS = 100;
const RENDER_INTERVAL_MS = 40;

function Replay({ run, scenario, trial, speed, onSpeed }: {
  run: DemoRun;
  scenario: DemoScenario;
  trial: DemoTrial;
  speed: Speed;
  onSpeed: (s: Speed) => void;
}) {
  const tl = useMemo(() => buildTimeline(trial, run.env?.buildMs), [trial, run.env?.buildMs]);
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const snap = snapshotAt(tl, elapsed);
  const speedRef = useRef(speed);
  const elapsedRef = useRef(0);
  useEffect(() => {
    speedRef.current = speed;
    elapsedRef.current = elapsed;
  });

  // Autoplay after mount (the server render is the static first frame). Reduced motion jumps to the finished state instead.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setElapsed(tl.total);
    else setPlaying(true);
  }, [tl]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let pos = elapsedRef.current;
    const frame = (now: number) => {
      const dt = Math.min(MAX_FRAME_DT_MS, now - last);
      last = now;
      acc += dt;
      pos = Math.min(tl.total, pos + dt * speedRef.current);
      if (pos >= tl.total || acc >= RENDER_INTERVAL_MS) {
        acc = 0;
        setElapsed(pos);
      }
      if (pos >= tl.total) setPlaying(false);
      else raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, tl]);

  const lastEvent = snap.shown > 0 ? tl.items[snap.shown - 1].event : null;
  const announce =
    snap.verdictShown ? `Replay finished. Trial ${trial.passed && !trial.error ? "passed" : "failed"}.`
    : playing && speed === 1 && lastEvent && lastEvent.type !== "tool" ? `${lastEvent.type === "user" ? "Customer" : "Agent"}: ${str(lastEvent.text).slice(0, 240)}`
    : "";

  const restart = () => { setElapsed(0); setPlaying(true); };

  return (
    <>
      <div className="order-2 lg:order-none lg:col-span-3 lg:row-start-1">
        <StepRail stepIndex={snap.stepIndex} progress={tl.total > 0 ? Math.min(1, elapsed / tl.total) : 0} />
      </div>

      <section aria-label="Conversation replay" className="order-3 min-w-0 border border-line-2 bg-bg-raised lg:order-none lg:col-start-2 lg:row-start-2">
        <Controls
          playing={playing}
          done={snap.done}
          speed={speed}
          gapsShortened={tl.gapsShortened}
          onToggle={() => setPlaying((p) => !p)}
          onSpeed={onSpeed}
          onSkip={() => { setPlaying(false); setElapsed(tl.total); }}
          onRestart={restart}
        />
        <Conversation items={tl.items} shown={snap.shown} typing={snap.typing} agentName={str(run.agent?.model)} idle={elapsed < tl.branchEnd} />
        <div className="sr-only" aria-live="polite" aria-atomic="true">{announce}</div>
      </section>

      <section aria-label="Sandbox world" className="order-4 min-w-0 border border-line-2 bg-bg-raised lg:order-none lg:col-start-3 lg:row-start-2">
        <World
          trial={trial}
          diffRevealed={snap.diffRevealed}
          outboxRevealed={snap.outboxRevealed}
          checksShown={snap.checksShown}
          graded={elapsed >= tl.gradeStart}
        />
        {snap.verdictShown ? <Verdict trial={trial} scenario={scenario} /> : null}
      </section>
    </>
  );
}

/** Open each scenario on a trial the agent actually completed (falls back to the first). */
function firstPassing(s: DemoRun["scenarios"][number] | undefined): number {
  const i = s?.trials?.findIndex((t) => t.passed) ?? -1;
  return i < 0 ? 0 : i;
}

export function DemoPlayer({ run }: { run: DemoRun }) {
  const scenarios = run.scenarios;
  const [si, setSi] = useState(0);
  const [ti, setTi] = useState(() => firstPassing(scenarios[0]));
  const [speed, setSpeed] = useState<Speed>(1);
  const scenario = scenarios[si];
  const trial = scenario.trials?.[ti] ?? scenario.trials?.[0];

  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-[250px_minmax(0,1fr)_380px]">
      <div className="order-1 min-w-0 lg:order-none lg:col-start-1 lg:row-start-2">
        <Picker
          scenarios={scenarios}
          scenarioIndex={si}
          trialIndex={ti}
          onScenario={(i) => { setSi(i); setTi(firstPassing(scenarios[i])); }}
          onTrial={setTi}
        />
      </div>
      {trial ? (
        <Replay key={`${si}-${ti}`} run={run} scenario={scenario} trial={trial} speed={speed} onSpeed={setSpeed} />
      ) : (
        <p className="order-3 text-muted lg:col-start-2">This scenario has no recorded trials.</p>
      )}
    </div>
  );
}
