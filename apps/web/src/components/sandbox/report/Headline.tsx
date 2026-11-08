import { Stat } from "@/components/ui";
import type { SandboxRunReport } from "../contract";
import { formatCi, formatUsd, pct, summarizeRun } from "../stats";

function CiBar({ rate, ci }: { rate: number; ci: [number, number] }) {
  return (
    <div role="img" aria-label={`Point estimate ${pct(rate)}, 95% interval ${formatCi(ci)}`} className="relative mt-1 h-2 w-full max-w-[220px] bg-line-2">
      <div className="absolute inset-y-0 bg-accent/40" style={{ left: `${ci[0] * 100}%`, width: `${Math.max((ci[1] - ci[0]) * 100, 0.5)}%` }} />
      <div className="absolute -inset-y-0.5 w-0.5 bg-accent-text" style={{ left: `calc(${rate * 100}% - 1px)` }} />
    </div>
  );
}

export function Headline({ report }: { report: SandboxRunReport }) {
  const s = summarizeRun(report.scenarios, report.results);
  return (
    <section aria-labelledby="headline-h" className="mt-12">
      <h2 id="headline-h" className="t-eyebrow mb-6 text-muted">Headline</h2>
      <div className="grid grid-cols-1 gap-x-8 gap-y-10 border-y border-line-2 py-8 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="pass^k reliability" value={pct(s.passK.rate)} hint={`${s.passK.passed} of ${s.passK.total} scenarios passed all ${report.k} trials`} />
        <div className="flex min-w-0 flex-col gap-2">
          <Stat label="pass^1 per trial" value={pct(s.pass1.rate)} hint={`95% CI ${formatCi(s.pass1.ci95)} (Wilson), ${s.pass1.passed}/${s.pass1.total} trials`} />
          <CiBar rate={s.pass1.rate} ci={s.pass1.ci95} />
        </div>
        <div className="flex flex-col gap-4">
          <Stat label="Utility" value={pct(s.utility.rate)} hint="Pass rate on non-attack scenarios. Higher is better." />
          <Stat label="Attack success" value={pct(s.attackSuccess.rate)} hint={`${s.attackSuccess.passed}/${s.attackSuccess.total} attack trials succeeded. Lower is better.`} className="[&>span:nth-child(2)]:text-[24px] md:[&>span:nth-child(2)]:text-[28px]" />
        </div>
        <Stat
          label="Total cost"
          value={formatUsd(report.costMicroUsd ?? s.costMicroUsd)}
          hint={`${s.trials} scored trials${report.costMicroUsd !== undefined ? " · all run spend incl. target tokens" : ""}`}
        />
      </div>
    </section>
  );
}
