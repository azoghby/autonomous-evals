
const CX = 160, CY = 130, R = 96;
const NODES = [-90, -18, 54, 126, 198].map((deg, i) => {
  const a = (deg * Math.PI) / 180;
  return { i, x: +(CX + R * 1.25 * Math.cos(a)).toFixed(1), y: +(CY + R * Math.sin(a)).toFixed(1) };
});

/** Decorative network: expert nodes feeding one finding node, pulses travelling along each edge. */
export function ExpertNetwork() {
  return (
    <figure aria-hidden className="relative isolate m-0 w-full max-w-[420px] justify-self-center">
      <span className="pointer-events-none absolute inset-0 -z-10" style={{ background: "radial-gradient(50% 50% at 50% 50%, rgb(42 95 255 / 0.14), transparent)" }} />
      <svg viewBox="0 0 320 260" className="h-auto w-full" fill="none" role="presentation">
        <defs>
          <pattern id="exp-dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.8" fill="var(--line-3)" /></pattern>
          <radialGradient id="exp-fade"><stop offset="55%" stopColor="#fff" /><stop offset="100%" stopColor="#000" /></radialGradient>
          <mask id="exp-mask"><rect width="320" height="260" fill="url(#exp-fade)" /></mask>
        </defs>
        <rect width="320" height="260" fill="url(#exp-dots)" mask="url(#exp-mask)" opacity="0.7" />
        {NODES.map((n) => (
          <g key={n.i}>
            <line x1={n.x} y1={n.y} x2={CX} y2={CY} stroke="var(--line-3)" strokeWidth="1" strokeDasharray="2 4" />
            <line x1={n.x} y1={n.y} x2={CX} y2={CY} pathLength={100} stroke="var(--accent-bright)" strokeWidth="1.5" strokeLinecap="round" className="ex-pulse" style={{ animationDelay: `${n.i * 0.6}s` }} />
          </g>
        ))}
        {NODES.map((n) => (
          <g key={`n${n.i}`}>
            <rect x={n.x - 14} y={n.y - 14} width="28" height="28" fill="var(--bg-raised)" stroke="var(--line-3)" />
            <path d={`M${n.x - 4} ${n.y + 5}c0-5 8-5 8 0M${n.x} ${n.y - 6}m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0`} stroke="var(--fg-2)" strokeWidth="1.1" />
            <text x={n.x} y={n.y + 27} textAnchor="middle" fill="var(--subtle)" fontFamily="var(--font-mono)" fontSize="8" letterSpacing="0.5">{`EXPERT 0${n.i + 1}`}</text>
          </g>
        ))}
        <circle cx={CX} cy={CY} r="16" stroke="var(--accent)" strokeWidth="1" className="ex-ring" />
        <rect x={CX - 30} y={CY - 16} width="60" height="32" fill="var(--bg)" stroke="var(--accent-bright)" />
        <rect x={CX - 3} y={CY - 16} width="6" height="1" fill="var(--accent-bright)" />
        <text x={CX} y={CY + 3.5} textAnchor="middle" fill="var(--fg)" fontFamily="var(--font-mono)" fontSize="10" letterSpacing="0.6">FINDING</text>
      </svg>
    </figure>
  );
}
