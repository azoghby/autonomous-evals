"use client";
import { Fragment, type ReactNode } from "react";
import { IconFile } from "./icons";
import { NOVA, NovaAvatar } from "./NovaAvatar";
import type { NovaUIMessage } from "./nova-types";
import type { CostAnswer } from "./parts/CostEstimate";
import { isToolPart, ToolPartView } from "./ToolPartView";

const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
const ATTACHED_RE = /^\[attached: (.+) \((.+), (\d+) KB\)\]$/;
const ACTION_RE = /^(Confirmed the run\.|Cancelled the run\.|Use the Acme sample world\.|Model: .+|Endpoint: .+|Added a system prompt\.)$/;

/** Plain text with http(s) links made clickable (React escapes the rest). Same-origin links stay in the tab. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>;
        const internal = typeof window !== "undefined" && p.startsWith(window.location.origin);
        const href = internal ? p.slice(window.location.origin.length) || "/" : p;
        return <a key={i} href={href} {...(internal ? {} : { target: "_blank", rel: "noopener noreferrer" })}>{internal ? href : p}</a>;
      })}
    </>
  );
}

const timeOf = (at?: string) => {
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

export function UserMessage({ message, cont, animate }: { message: NovaUIMessage; cont: boolean; animate: boolean }) {
  const text = message.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const lines = text.split("\n");
  const files = lines.map((l) => ATTACHED_RE.exec(l.trim())).filter((m): m is RegExpExecArray => !!m);
  const prose = lines.filter((l) => !ATTACHED_RE.test(l.trim())).join("\n").trim();
  const actionOnly = prose.length > 0 && prose.split("\n").every((l) => ACTION_RE.test(l.trim()));
  return (
    <li className={`nv-msg-user${animate ? " nv-enter" : ""}`} data-cont={cont} data-nv-message>
      <span className="sr-only">You said:</span>
      {prose && (actionOnly ? <p className="nv-user-action">{prose}</p> : <p className="nv-user-text">{prose}</p>)}
      {files.map((f) => (
        <p key={f[0]} className="nv-file"><IconFile /><span>{f[1]}</span><small>{f[2]}, {f[3]} KB</small></p>
      ))}
    </li>
  );
}

interface AssistantProps {
  message: NovaUIMessage;
  cont: boolean;
  animate: boolean;
  streaming: boolean;
  interactive: boolean;
  answer: CostAnswer;
  thinking?: ReactNode;
}

export function AssistantMessage({ message, cont, animate, streaming, interactive, answer, thinking }: AssistantProps) {
  const text = message.parts.filter((p) => p.type === "text").map((p) => p.text).join("");
  const tools = message.parts.filter(isToolPart);
  const time = timeOf(message.metadata?.at);
  return (
    <li className={`nv-msg${animate ? " nv-enter" : ""}`} data-cont={cont} data-nv-message>
      <span className="nv-gutter">{!cont && <NovaAvatar busy={streaming} />}</span>
      <div className="nv-body">
        {!cont && (
          <p className="nv-byline"><b>{NOVA.name}</b><span>{NOVA.role}{time ? `, ${time}` : ""}</span></p>
        )}
        {thinking}
        {text && (
          <p className="nv-text">
            <span className="sr-only">Nova said: </span>
            <Linkified text={text} />
            {streaming && <span className="nv-caret" aria-hidden="true" />}
          </p>
        )}
        {tools.map((p, i) => <ToolPartView key={p.toolCallId} part={p} index={i} interactive={interactive} answer={answer} />)}
      </div>
    </li>
  );
}

export function ThinkingRow({ label }: { label: string }) {
  return <p className="nv-thinking" role="status"><span className="nv-shimmer">{label}</span></p>;
}
