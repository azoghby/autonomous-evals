"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { EvalListItem } from "@/lib/eval-chat/types";
import { KIND_LABEL, humanize, pct, relativeDate, type Tone } from "./format";

type State = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; evals: EvalListItem[] };

const statusTone = (s: string): Tone => {
  const v = s.toLowerCase();
  if (v === "complete" || v === "completed" || v === "ready" || v === "delivered") return "ok";
  if (v === "failed" || v === "error") return "danger";
  if (v === "running" || v === "queued" || v === "generating" || v === "gating") return "accent";
  return "muted";
};

export function EvalList() {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    fetch("/api/evals", { signal: ctl.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`The server answered ${res.status}`);
        const body = (await res.json()) as { evals?: EvalListItem[] };
        setState({ phase: "ready", evals: body.evals ?? [] });
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setState({ phase: "error", message: e instanceof Error ? e.message : "Request failed" });
      });
    return () => ctl.abort();
  }, [attempt]);

  if (state.phase === "loading") {
    return <div className="ec-evals-skel" role="status" aria-label="Loading evals">{[0, 1, 2, 3].map((i) => <div key={i} className="ec-skel" />)}</div>;
  }
  if (state.phase === "error") {
    return (
      <div className="ec-evals-wrap"><div className="ec-errbox" role="alert">
        <p className="ec-text"><span className="ec-strong">Could not load your evals.</span> {state.message}. Check your connection and try again.</p>
        <button type="button" className="ec-btn" data-variant="outline" onClick={() => { setState({ phase: "loading" }); setAttempt((a) => a + 1); }}>Try again</button>
      </div></div>
    );
  }
  if (state.evals.length === 0) {
    return (
      <div className="ec-evals-empty">
        <p className="ec-empty-title">No evals yet</p>
        <p className="ec-text">Run your first sandbox eval, then ask the copilot why trials failed.</p>
        <Link className="ec-btn" data-variant="primary" href="/sandbox/new">Create an eval</Link>
      </div>
    );
  }
  return (
    <ul className="ec-evals" aria-label="Evals">
      {state.evals.map((e) => (
        <li key={`${e.kind}:${e.id}`} className="ec-eval">
          <Link className="ec-eval-main" href={e.href}>
            <span className="ec-eval-name">{e.name}</span>
            <span className="ec-eval-meta">
              <span className="ec-tag">{KIND_LABEL[e.kind]}</span>
              <span className="ec-status" data-tone={statusTone(e.status)}><span className="ec-dot" aria-hidden="true" />{humanize(e.status)}</span>
              {e.passAt1 != null ? <span className="ec-mono">pass@1 {pct(e.passAt1)}</span> : null}
              {e.passHatK != null ? <span className="ec-mono">pass^{e.k ?? "k"} {pct(e.passHatK)}</span> : null}
              <span className="ec-dim">{relativeDate(e.createdAt)}</span>
            </span>
            {e.detail ? <span className="ec-eval-detail">{e.detail}</span> : null}
          </Link>
          <Link className="ec-btn" data-variant="outline" data-size="sm" href={`${e.href}${e.href.includes("?") ? "&" : "?"}ask=1`} aria-label={`Ask about ${e.name}`}>Ask</Link>
        </li>
      ))}
    </ul>
  );
}
