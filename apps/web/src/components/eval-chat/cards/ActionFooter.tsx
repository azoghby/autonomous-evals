import type { ReactNode } from "react";
import type { ActionState } from "../context";
import { RunProgress } from "./RunProgress";

type Props = {
  action: ActionState;
  confirmLabel: string;
  pendingLabel?: string;
  canConfirm?: boolean;
  /** Shown instead of the buttons' enabled state explanation when confirm is blocked. */
  blockedReason?: string | null;
  /** Extra settled content (e.g. share link). */
  settled?: ReactNode;
};

/** Confirm / Cancel footer shared by every action card, including the settled states after a decision. */
export function ActionFooter({ action, confirmLabel, pendingLabel = "Starting", canConfirm = true, blockedReason, settled }: Props) {
  const { status, result, pending, error, decide } = action;

  if (status === "proposed") {
    return (
      <div className="ec-action">
        <div className="ec-actions">
          <button type="button" className="ec-btn" data-variant="primary" disabled={!canConfirm || pending !== null} onClick={() => void decide("confirm")}>
            {pending === "confirm" ? `${pendingLabel}…` : confirmLabel}
          </button>
          <button type="button" className="ec-btn" data-variant="outline" disabled={pending !== null} onClick={() => void decide("cancel")}>
            {pending === "cancel" ? "Cancelling…" : "Cancel"}
          </button>
        </div>
        {!canConfirm && blockedReason ? <p className="ec-dim">{blockedReason}</p> : null}
        {error ? <p className="ec-text" data-tone="danger" role="alert">{error}</p> : null}
      </div>
    );
  }
  if (status === "executing") return <p className="ec-status" data-tone="accent" role="status"><span className="ec-dot" aria-hidden="true" />{pendingLabel}…</p>;
  if (status === "executed") {
    return (
      <div className="ec-action">
        <p className="ec-status" data-tone="ok" role="status"><span className="ec-dot" aria-hidden="true" />Confirmed{result?.runId ? ". Run started." : "."}</p>
        {result?.runId ? <RunProgress runId={result.runId} /> : null}
        {settled}
      </div>
    );
  }
  if (status === "cancelled") return <p className="ec-status" data-tone="muted" role="status"><span className="ec-dot" aria-hidden="true" />Cancelled. Nothing was run.</p>;
  if (status === "expired") return <p className="ec-status" data-tone="warn" role="status"><span className="ec-dot" aria-hidden="true" />This proposal expired. Ask again for a fresh one.</p>;
  return <p className="ec-status" data-tone="danger" role="alert"><span className="ec-dot" aria-hidden="true" />{result?.error ?? "The action failed. Ask again to retry."}</p>;
}
