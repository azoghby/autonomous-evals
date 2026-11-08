import type { CSSProperties } from "react";

/** Trial outcomes for the sample run (3 of 5 pass). `focus` marks the trial whose trajectory is shown. */
export const TRIALS = [
  { id: "t1", pass: true },
  { id: "t2", pass: true },
  { id: "t3", pass: false },
  { id: "t4", pass: false, focus: true },
  { id: "t5", pass: true },
] as const;

const W = 320;
const H = 200;
const FORK_X = 92;
const END_X = 276;
const GOLDEN = { x: 20, y: 100 };
const ys = [22, 61, 100, 139, 178];
const branchPath = (y: number) => `M${FORK_X} ${GOLDEN.y} C ${FORK_X + 48} ${GOLDEN.y}, ${FORK_X + 40} ${y}, ${FORK_X + 92} ${y} H ${END_X}`;

const stroke = (tone: "line" | "accent"): CSSProperties => ({ stroke: tone === "accent" ? "var(--accent)" : "var(--line-3)" });

/** Decorative branch tree: golden world -> five isolated trial branches. Pulses are stroke-dashoffset only. */
export function BranchTree() {
  return (
    <svg aria-hidden viewBox={`0 0 ${W} ${H}`} className="ss-tree block h-auto w-full" fill="none" focusable="false">
      {/* trunk */}
      <path d={`M${GOLDEN.x} ${GOLDEN.y} H${FORK_X}`} pathLength={1} className="ss-draw" style={{ ...stroke("accent"), "--i": 0 } as CSSProperties} strokeWidth={1.25} />
      <path d={`M${GOLDEN.x} ${GOLDEN.y} H${FORK_X}`} pathLength={1} className="ss-pulse" style={{ ...stroke("accent"), "--i": 0 } as CSSProperties} strokeWidth={2} strokeLinecap="round" />
      {ys.map((y, i) => (
        <g key={y}>
          <path d={branchPath(y)} pathLength={1} className="ss-draw" style={{ ...stroke("line"), "--i": i + 1 } as CSSProperties} strokeWidth={1.25} />
          <path d={branchPath(y)} pathLength={1} className="ss-pulse" style={{ ...stroke("accent"), "--i": i + 1 } as CSSProperties} strokeWidth={2} strokeLinecap="round" />
        </g>
      ))}
      {/* golden node */}
      <circle cx={GOLDEN.x} cy={GOLDEN.y} r={9} style={{ fill: "var(--bg)", stroke: "var(--accent)" }} strokeWidth={1.25} />
      <circle cx={GOLDEN.x} cy={GOLDEN.y} r={3.5} style={{ fill: "var(--accent)" }} />
      <circle cx={FORK_X} cy={GOLDEN.y} r={2.5} style={{ fill: "var(--line-3)" }} />
      {/* trial nodes */}
      {TRIALS.map((t, i) => {
        const y = ys[i] ?? 0;
        const tone = t.pass ? "var(--ok)" : "var(--danger)";
        return (
          <g key={t.id} className="ss-node" style={{ "--i": i + 1 } as CSSProperties}>
            {"focus" in t && t.focus && <circle cx={END_X} cy={y} r={10} style={{ stroke: "var(--accent)" }} strokeWidth={1} strokeDasharray="2 3" />}
            <circle cx={END_X} cy={y} r={5} style={{ fill: "var(--bg)", stroke: tone }} strokeWidth={1.5} />
            <circle cx={END_X} cy={y} r={2} style={{ fill: tone }} />
            <text x={END_X + 16} y={y + 3.5} style={{ fill: "var(--subtle)", fontFamily: "var(--font-mono)", fontSize: 10 }}>{t.id}</text>
          </g>
        );
      })}
    </svg>
  );
}
