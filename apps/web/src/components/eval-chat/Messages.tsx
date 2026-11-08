"use client";
import { memo, useEffect, useRef, type ReactNode } from "react";
import type { EvalUIMessage } from "@/lib/eval-chat/types";
import { hasVisibleText } from "./format";
import { RichText } from "./RichText";
import { ToolPart } from "./ToolPart";

const NEAR_BOTTOM_PX = 96;

function Glyph() {
  return (
    <span className="ec-avatar" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16"><rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" /><rect x="5" y="5" width="6" height="6" fill="currentColor" /></svg>
    </span>
  );
}

export function Thinking({ label }: { label: string }) {
  return (
    <div className="ec-msg" data-role="assistant" role="status">
      <Glyph />
      <div className="ec-msg-body"><p className="ec-shimmer">{label}</p></div>
    </div>
  );
}

export const messageHasContent = (m: EvalUIMessage): boolean =>
  m.parts.some((p) => (p.type === "text" && hasVisibleText(p.text)) || p.type.startsWith("tool-"));

const Message = memo(function Message({ message }: { message: EvalUIMessage }) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return <div className="ec-msg" data-role="user"><div className="ec-bubble">{text}</div></div>;
  }
  const nodes: ReactNode[] = message.parts.map((p, i) => {
    if (p.type === "text") return hasVisibleText(p.text) ? <RichText key={i} text={p.text} /> : null;
    return p.type.startsWith("tool-") ? <div key={i} className="ec-part"><ToolPart part={p} /></div> : null;
  });
  return (
    <div className="ec-msg" data-role="assistant">
      <Glyph />
      <div className="ec-msg-body">{nodes}</div>
    </div>
  );
});

type ListProps = { messages: EvalUIMessage[]; thinking: string | null; scrollKey: unknown; sendCount: number; children?: ReactNode };

/** Message list. Follows the stream only while the reader is already near the bottom; sending always jumps to the bottom. */
export function Messages({ messages, thinking, scrollKey, sendCount, children }: ListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    stick.current = true;
  }, [sendCount]);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [scrollKey, sendCount, thinking]);

  return (
    <div
      ref={ref}
      className="ec-scrollarea"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      }}
    >
      {children}
      {messages.map((m) => (m.role === "assistant" && !messageHasContent(m) ? null : <Message key={m.id} message={m} />))}
      {thinking ? <Thinking label={thinking} /> : null}
    </div>
  );
}
