import type { RunCompareCard } from "@/lib/eval-chat/types";
import { CHANGE_TONE, pct, ratio, relativeDate } from "../format";
import { ToolFrame } from "../ToolFrame";

type Side = RunCompareCard["base"];

function Headline({ label, side }: { label: string; side: Side }) {
  return (
    <div className="ec-cmp-col">
      <span className="ec-cap">{label}</span>
      <span className="ec-row-title">{side.name}</span>
      <span className="ec-dim ec-mono">{relativeDate(side.createdAt)} · k={side.k}</span>
      <span className="ec-cmp-nums"><span><span className="ec-big ec-big-sm">{pct(side.passAt1)}</span> <span className="ec-cap">pass@1</span></span><span><span className="ec-big ec-big-sm">{pct(side.passHatK)}</span> <span className="ec-cap">pass^k</span></span></span>
    </div>
  );
}

const CHANGE_LABEL = { fixed: "Fixed", regressed: "Regressed", same: "Same", added: "Added", removed: "Removed" } as const;
const cell = (c: { passed: number; total: number } | null) => (c ? ratio(c.passed, c.total) : "–");

export function RunCompare({ data }: { data: RunCompareCard }) {
  const delta = Math.round((data.other.passAt1 - data.base.passAt1) * 100);
  return (
    <ToolFrame title="Run comparison" stateLabel={`${delta > 0 ? "+" : ""}${delta} pts pass@1`} tone={delta > 0 ? "ok" : delta < 0 ? "danger" : "muted"}>
      <div className="ec-cmp"><Headline label="Base" side={data.base} /><Headline label="Compared" side={data.other} /></div>
      <ul className="ec-rows" aria-label="Scenario changes">
        {data.rows.map((r) => (
          <li key={r.scenarioId} className="ec-row">
            <span className="ec-row-main"><span className="ec-row-title">{r.title}</span><span className="ec-row-sub ec-mono">{cell(r.base)} to {cell(r.other)}</span></span>
            <span className="ec-badge" data-tone={CHANGE_TONE[r.change]}>{CHANGE_LABEL[r.change]}</span>
          </li>
        ))}
      </ul>
    </ToolFrame>
  );
}
