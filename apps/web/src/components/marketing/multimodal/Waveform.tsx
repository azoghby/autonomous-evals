const bar = (i: number, n: number, seed: number) => {
  const env = Math.sin((i / (n - 1)) * Math.PI);
  const wob = 0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + seed));
  const hi = Math.max(0.16, env * wob);
  return { hi: hi.toFixed(2), lo: Math.max(0.1, hi * 0.35).toFixed(2), d: `${((i * 97 + seed * 130) % 900) - 900}ms`, p: `${(0.7 + ((i * 31) % 7) / 10).toFixed(1)}s` };
};

/** Decorative bar waveform. Motion = scaleY only; static (at peak height) when paused / reduced motion. */
export function Waveform({ count, seed, tone, delay = 0 }: { count: number; seed: number; tone: "caller" | "agent"; delay?: number }) {
  const w = 4, gap = 3, h = 44;
  const width = count * (w + gap) - gap;
  return (
    <svg aria-hidden viewBox={`0 0 ${width} ${h}`} preserveAspectRatio="none" className={`mm-wave mm-wave-${tone} block h-11 w-full`} style={{ ["--lane-delay" as string]: `${delay}ms` }}>
      {Array.from({ length: count }, (_, i) => {
        const b = bar(i, count, seed);
        return <rect key={i} className="mm-bar" x={i * (w + gap)} y={0} width={w} height={h} rx={1} style={{ ["--hi" as string]: b.hi, ["--lo" as string]: b.lo, ["--d" as string]: b.d, ["--p" as string]: b.p }} />;
      })}
    </svg>
  );
}
