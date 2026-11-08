import type { ReactNode } from "react";
import type { Tone } from "./format";

type FrameProps = {
  title: string;
  /** Small right-aligned state label ("Done", "Waiting for you"). */
  stateLabel?: string;
  tone?: Tone;
  children: ReactNode;
  footer?: ReactNode;
};

/** Shared card chrome: hairline box, header (title + state), body, optional footer. */
export function ToolFrame({ title, stateLabel, tone = "muted", children, footer }: FrameProps) {
  return (
    <section className="ec-tool" aria-label={title}>
      <header className="ec-tool-head">
        <span className="ec-tool-title">{title}</span>
        {stateLabel ? <span className="ec-tool-state" data-tone={tone}>{stateLabel}</span> : null}
      </header>
      <div className="ec-tool-body">{children}</div>
      {footer ? <footer className="ec-tool-foot">{footer}</footer> : null}
    </section>
  );
}

/** Pending skeleton while a tool input streams or runs. */
export function ToolSkeleton({ title, label }: { title: string; label: string }) {
  return (
    <section className="ec-tool" aria-busy="true" aria-label={title}>
      <header className="ec-tool-head">
        <span className="ec-tool-title">{title}</span>
        <span className="ec-tool-state" data-tone="accent">Working</span>
      </header>
      <div className="ec-tool-body">
        <p className="ec-skel-label">{label}</p>
        <div className="ec-skel" /><div className="ec-skel" data-short="" />
      </div>
    </section>
  );
}

/** Compact failure row for a tool that errored. */
export function ToolError({ title, text }: { title: string; text?: string }) {
  return (
    <div className="ec-tool-error" role="alert">
      <span className="ec-mark" data-tone="danger" aria-hidden="true" />
      <span><b className="ec-strong">{title} failed.</b> {text ? <span>{text}</span> : <span>Ask again or try a different question.</span>}</span>
    </div>
  );
}
