"use client";
import { useState } from "react";
import type { EvidenceCardData } from "@/lib/eval-chat/types";
import { attributionText, severityTone } from "../format";
import { ToolFrame } from "../ToolFrame";
import { StateDiffRows } from "./StateDiffTable";

const COLLAPSED_LINES = 4;
const ROLE: Record<string, string> = { user: "User", assistant: "Agent", tool: "Tool" };

export function Excerpt({ lines }: { lines: EvidenceCardData["excerpt"] }) {
  const [open, setOpen] = useState(false);
  const long = lines.length > COLLAPSED_LINES;
  const shown = open || !long ? lines : lines.slice(0, COLLAPSED_LINES);
  return (
    <div className="ec-sub">
      <p className="ec-sub-title">Transcript excerpt</p>
      <div className="ec-transcript">
        {shown.map((l, i) => (
          <p key={i} className="ec-turn" data-role={l.role}><span className="ec-role">{ROLE[l.role] ?? l.role}</span>{l.content}</p>
        ))}
      </div>
      {long ? <button type="button" className="ec-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Show less" : `Show ${lines.length - COLLAPSED_LINES} more turns`}</button> : null}
    </div>
  );
}

export function EvidenceCard({ data }: { data: EvidenceCardData }) {
  return (
    <ToolFrame title={data.scenarioTitle} stateLabel={data.passed ? "Passed" : "Failed"} tone={data.passed ? "ok" : "danger"}>
      <p className="ec-meta">Trial {data.trial} of {data.trials}{data.attribution ? ` · ${attributionText(data.attribution)}` : ""}</p>
      {data.error ? <p className="ec-text" data-tone="danger">{data.error}</p> : null}
      {data.failedChecks.length > 0 ? (
        <div className="ec-sub">
          <p className="ec-sub-title">Failed checks</p>
          <ul className="ec-list">
            {data.failedChecks.map((c) => (
              <li key={c.id}>
                <span className="ec-mark" data-tone={severityTone(c.severity)} aria-hidden="true" />
                <span><span className="ec-sr">{c.severity} severity: </span>{c.detail}{c.policyRef ? <span className="ec-dim ec-mono"> · {c.policyRef}</span> : null}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {data.excerpt.length > 0 ? <Excerpt lines={data.excerpt} /> : null}
      {data.diff.length > 0 ? <div className="ec-sub"><p className="ec-sub-title">Data changes</p><StateDiffRows rows={data.diff} /></div> : null}
    </ToolFrame>
  );
}
