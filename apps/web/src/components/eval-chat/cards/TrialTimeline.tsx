"use client";
import { useState } from "react";
import type { TimelineStep, TrialTimelineCard } from "@/lib/eval-chat/types";
import { clip, orderTimeline } from "../format";
import { ToolFrame } from "../ToolFrame";

const DETAIL_LIMIT = 280;
const KIND: Record<TimelineStep["kind"], string> = { user: "User", assistant: "Agent", tool: "Tool call" };

function Step({ step }: { step: TimelineStep }) {
  const [open, setOpen] = useState(false);
  const c = clip(step.detail, DETAIL_LIMIT);
  const failed = Boolean(step.error);
  return (
    <li className="ec-step" data-kind={step.kind} data-failed={failed ? "true" : "false"}>
      <span className="ec-step-dot" aria-hidden="true" />
      <div className="ec-step-body">
        <p className="ec-step-head">
          <span className="ec-role">{KIND[step.kind]}</span>
          {step.kind === "tool" ? <span className="ec-mono ec-strong">{step.label}</span> : null}
          {step.ms != null ? <span className="ec-dim ec-mono">{step.ms} ms</span> : null}
          {step.error ? <span className="ec-badge" data-tone="danger">Error</span> : null}
          {step.fault ? <span className="ec-badge" data-tone="warn">Fault: {step.fault}</span> : null}
        </p>
        {step.error ? <p className="ec-text" data-tone="danger">{step.error}</p> : null}
        {step.detail ? <p className="ec-detail">{open ? step.detail : c.text}</p> : null}
        {c.clipped ? <button type="button" className="ec-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Show less" : "Show full"}</button> : null}
      </div>
    </li>
  );
}

export function TrialTimeline({ data }: { data: TrialTimelineCard }) {
  const steps = orderTimeline(data.steps);
  return (
    <ToolFrame title={`${data.scenarioTitle}, trial ${data.trial}`} stateLabel={data.passed ? "Passed" : "Failed"} tone={data.passed ? "ok" : "danger"}>
      <ol className="ec-timeline">{steps.map((s) => <Step key={s.seq} step={s} />)}</ol>
      {steps.length === 0 ? <p className="ec-dim">No steps were recorded for this trial.</p> : null}
    </ToolFrame>
  );
}
