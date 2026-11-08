import type { DemoScenario, DemoTrial } from "./demo-run-types";
import { clamp01, pct, str, usd } from "./format";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="t-eyebrow text-subtle">{label}</dt>
      <dd className="t-data mt-1 text-fg">{value}</dd>
    </div>
  );
}

/** Wilson 95% interval as a hairline track with the observed pass rate marked. */
function IntervalBar({ lo, hi, rate }: { lo: number; hi: number; rate: number }) {
  return (
    <div>
      <div className="relative h-1.5 bg-line-2" role="img" aria-label={`95% interval ${pct(lo)} to ${pct(hi)}, observed ${pct(rate)}`}>
        <div className="absolute inset-y-0 bg-accent/50" style={{ left: `${lo * 100}%`, width: `${Math.max(0, hi - lo) * 100}%` }} />
        <div className="absolute -inset-y-1 w-0.5 bg-fg" style={{ left: `calc(${rate * 100}% - 1px)` }} />
      </div>
      <div className="t-data mt-1.5 flex justify-between text-subtle">
        <span>0%</span>
        <span>{pct(lo)} – {pct(hi)}</span>
        <span>100%</span>
      </div>
    </div>
  );
}

export function Verdict({ trial, scenario }: { trial: DemoTrial; scenario: DemoScenario }) {
  const lo = clamp01(scenario.ci95?.[0]);
  const hi = clamp01(scenario.ci95?.[1]);
  const passed = !!trial.passed && !trial.error;
  // Simulator/environment failures are never counted against the agent (engine countedTrials()).
  const excluded = !passed && (trial.failureAttribution === "simulator" || trial.failureAttribution === "environment");
  const ours = trial.costUsd ?? 0;
  const agent = trial.agentCostUsd ?? 0;
  return (
    <div className={`demo-in border-t ${passed ? "border-ok/40" : excluded ? "border-line-2" : "border-danger/40"} bg-bg-band px-4 py-5`} role="status">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className={`text-[28px] leading-none tracking-[-0.03em] ${passed ? "text-ok" : excluded ? "text-fg-2" : "text-danger"}`}>
          {passed ? "Trial passed" : excluded ? "Not counted" : trial.error ? "Run errored" : "Trial failed"}
        </div>
        <span className="t-eyebrow text-muted">Trial {(trial.trial ?? 0) + 1} of {scenario.k ?? scenario.trials?.length}</span>
      </div>

      {excluded ? (
        <p className="mt-3 text-[13px] leading-[1.5] text-fg-2">
          The {str(trial.failureAttribution)} failed, not the agent, so this trial is excluded from the score.
        </p>
      ) : null}
      {trial.error ? <p className={`mt-3 break-words text-[13px] [overflow-wrap:anywhere] ${excluded ? "text-subtle" : "text-danger"}`}>{str(trial.error)}</p> : null}
      {!passed && !excluded && trial.failureAttribution ? (
        <p className="mt-3 break-words border-l-2 border-danger/60 pl-3 text-[13px] leading-[1.5] text-fg-2 [overflow-wrap:anywhere]">
          <span className="t-eyebrow mb-1 block text-subtle">Failure attribution</span>
          {str(trial.failureAttribution)}
        </p>
      ) : null}

      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
        <Stat label={`Scenario pass^${scenario.k ?? ""}`} value={scenario.reliable ? "reliable" : "not reliable"} />
        <Stat label="Pass rate" value={pct(scenario.passRate)} />
        <Stat label="Our cost" value={usd(ours)} />
        <Stat label="Agent cost" value={usd(agent)} />
      </dl>

      <div className="mt-5">
        <div className="t-eyebrow mb-2 text-subtle">Wilson 95% interval · this scenario</div>
        <IntervalBar lo={lo} hi={Math.max(lo, hi)} rate={clamp01(scenario.passRate)} />
      </div>
    </div>
  );
}
