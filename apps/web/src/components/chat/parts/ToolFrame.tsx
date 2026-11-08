import type { CSSProperties, ReactNode } from "react";
import { IconAlert } from "../icons";

export type FrameState = "loading" | "partial" | "done" | "error" | "warn" | "idle";

interface Props {
  title: string;
  state: FrameState;
  stateLabel?: string;
  tone?: "accent" | "warn" | "ok";
  index?: number;
  foot?: ReactNode;
  /** Body padding off (for edge-to-edge rows). */
  flush?: boolean;
  children?: ReactNode;
  labelledBy?: string;
}

const DEFAULT_LABEL: Record<FrameState, string> = { loading: "Loading", partial: "In progress", done: "Ready", error: "Unavailable", warn: "Needs review", idle: "" };

/** Shared instrument frame for every generative component: titled header, state pill, body, optional footer. */
export function ToolFrame({ title, state, stateLabel, tone = "accent", index = 0, foot, flush, children, labelledBy }: Props) {
  const label = stateLabel ?? DEFAULT_LABEL[state];
  return (
    <section
      className="nv-tool nv-tool-enter"
      data-state={state === "error" ? "error" : undefined}
      data-tone={tone === "accent" ? undefined : tone}
      aria-labelledby={labelledBy}
      aria-busy={state === "loading" || state === "partial"}
      style={{ "--i": index } as CSSProperties}
    >
      <header className="nv-tool-head">
        <h3 className="nv-tool-title" id={labelledBy}>{title}</h3>
        {label && <span className="nv-state" data-s={state}>{label}</span>}
      </header>
      {children !== undefined && <div className={flush ? undefined : "nv-tool-body"}>{children}</div>}
      {foot && <footer className="nv-tool-foot">{foot}</footer>}
    </section>
  );
}

export function FrameSkeleton({ rows = 3 }: { rows?: number }) {
  const widths = ["72%", "54%", "64%", "40%", "58%"];
  return (
    <div className="nv-skel-stack" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => <span key={i} className="nv-skel" style={{ width: widths[i % widths.length] }} />)}
    </div>
  );
}

export function FrameError({ text }: { text: string }) {
  return <p className="nv-error" role="status"><IconAlert />{text}</p>;
}
