
const R = 46;
const C = +(2 * Math.PI * R).toFixed(2);

/** Server-rendered ring; arc draws via stroke-dashoffset when the parent InView flips. */
export function PassRing({ pass, total }: { pass: number; total: number }) {
  const pct = Math.round((pass / total) * 100);
  const off = +(C * (1 - pass / total)).toFixed(2);
  return (
    <div className="relative size-[7.5rem] shrink-0" role="img" aria-label={`${pass} of ${total} design-suite checks pass (${pct}%)`}>
      <svg aria-hidden viewBox="0 0 112 112" className="size-full -rotate-90">
        <circle cx="56" cy="56" r={R} fill="none" stroke="var(--line-2)" strokeWidth="6" />
        <circle cx="56" cy="56" r={R} fill="none" stroke="var(--accent-text)" strokeWidth="6" strokeLinecap="butt"
          className={"rp-ring-arc"} style={{ ["--c" as string]: C, ["--off" as string]: off }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-[28px] leading-none tracking-[-0.04em] text-fg tabular-nums">{pct}%</span>
        <span className="mt-1 font-mono text-[10px] uppercase text-subtle">pass rate</span>
      </div>
    </div>
  );
}
