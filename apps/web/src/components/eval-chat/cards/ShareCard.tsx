"use client";
import type { ShareCard as Share } from "@/lib/eval-chat/types";
import { useAction } from "../context";
import { ToolFrame } from "../ToolFrame";
import { ActionFooter } from "./ActionFooter";
import { actionStateLabel, actionTone } from "./actionState";

export function ShareCard({ data }: { data: Share }) {
  const action = useAction(data);
  const shareUrl = action.result?.shareUrl;
  return (
    <ToolFrame title="Share this report" stateLabel={data.shareable ? actionStateLabel(action.status) : "Not shareable"} tone={data.shareable ? actionTone(action.status) : "warn"}>
      {data.downloads.length > 0 ? (
        <ul className="ec-list" aria-label="Downloads">
          {data.downloads.map((d) => <li key={d.href}><a className="ec-link" href={d.href} download>{d.label}</a></li>)}
        </ul>
      ) : null}
      {data.shareable ? (
        <ActionFooter
          action={action}
          confirmLabel="Create share link"
          pendingLabel="Creating link"
          settled={shareUrl ? <p className="ec-text">Anyone with <a className="ec-link" href={shareUrl}>this link</a> can view the report.</p> : null}
        />
      ) : (
        <p className="ec-dim">{data.reason ?? "This report cannot be shared yet."}</p>
      )}
    </ToolFrame>
  );
}
