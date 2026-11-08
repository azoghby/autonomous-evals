"use client";

import { useEffect, useRef, useState } from "react";
import { Chip } from "@/components/ui";
import type { TimelineItem, TypingKind } from "./replay";
import { json, ms, str } from "./format";

type ToolEvent = Extract<TimelineItem["event"], { type: "tool" }>;

const TYPING_LABEL: Record<TypingKind, string> = {
  user: "Customer is typing",
  assistant: "Agent is thinking",
  tool: "Agent is calling a tool",
};

const EFFECT_TONE = { read: "muted", write: "accent", external: "warn", unknown: "muted" } as const;

function Dots() {
  return (
    <span aria-hidden className="inline-flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <span key={i} className="demo-dot size-1 rounded-full bg-muted" style={{ animationDelay: `${i * 160}ms` }} />
      ))}
    </span>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <div className="t-eyebrow mb-1 text-subtle">{label}</div>
      <pre className="t-data max-h-48 overflow-auto rounded-[2px] border border-line bg-bg p-2 text-fg-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {json(value)}
      </pre>
    </div>
  );
}

function ToolRow({ e }: { e: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const effect = e.effect in EFFECT_TONE ? e.effect : "unknown";
  const blocked = e.executed === false;
  return (
    <div className="demo-in rounded-[2px] border border-line-2 bg-bg-band">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-left transition-colors hover:bg-bg-hover"
      >
        <span aria-hidden className={`t-data inline-block transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        <span className="t-data min-w-0 break-all text-fg">{str(e.tool) || "(unnamed tool)"}</span>
        <Chip tone={EFFECT_TONE[effect as keyof typeof EFFECT_TONE]}>{effect}</Chip>
        {e.fault ? <Chip tone="danger" dot>{str(e.fault)}</Chip> : null}
        {e.error ? <Chip tone="danger">error</Chip> : null}
        {blocked ? <Chip tone="warn">not executed</Chip> : null}
        <span className="t-data ml-auto text-subtle">{ms(e.ms)}</span>
      </button>
      {open ? (
        <div className="grid gap-3 border-t border-line px-3 py-3 sm:grid-cols-2">
          <JsonBlock label="args" value={e.args} />
          <JsonBlock label={e.error ? "error" : "result"} value={e.error ? e.error : e.result} />
        </div>
      ) : null}
    </div>
  );
}

/** Agents reply in light markdown: render **bold** as <strong> (as React text, never HTML) and keep line breaks. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*\n]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? <strong key={i} className="font-medium text-white">{p.slice(2, -2)}</strong> : p,
      )}
    </>
  );
}

function Bubble({ item, agentName }: { item: TimelineItem; agentName: string }) {
  const e = item.event;
  if (e.type === "tool") return <ToolRow e={e} />;
  const isUser = e.type === "user";
  return (
    <div className={`demo-in flex flex-col gap-1 ${isUser ? "items-start" : "items-end"}`}>
      <span className="t-eyebrow text-subtle">{isUser ? "Customer · simulated" : `Agent · ${agentName}`}</span>
      <p
        className={`max-w-[88%] whitespace-pre-wrap break-words rounded-[4px] border px-3.5 py-2.5 text-[14px] leading-[1.55] [overflow-wrap:anywhere] ${
          isUser ? "border-line-2 bg-bg-raised text-fg" : "border-accent/40 bg-accent-soft text-fg"
        }`}
      >
        {str(e.text) ? <RichText text={str(e.text)} /> : <span className="text-subtle">(empty message)</span>}
      </p>
    </div>
  );
}

export function Conversation({
  items,
  shown,
  typing,
  agentName,
  idle,
}: {
  items: TimelineItem[];
  shown: number;
  typing: TypingKind | null;
  agentName: string;
  /** True before playback has produced anything. */
  idle: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown, typing]);

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      tabIndex={0}
      aria-label="Conversation transcript"
      className="flex h-[480px] flex-col gap-3 overflow-y-auto overflow-x-hidden px-4 py-4 lg:h-[560px]"
    >
      {shown === 0 && !typing ? (
        <p className="m-auto max-w-[32ch] text-center text-[14px] text-subtle">
          {idle ? "Preparing a sandbox world…" : "The conversation begins once the world is ready."}
        </p>
      ) : null}
      {items.slice(0, shown).map((it, i) => (
        <Bubble key={i} item={it} agentName={agentName} />
      ))}
      {typing ? (
        <div className={`flex items-center gap-2 text-subtle ${typing === "user" ? "" : "justify-end"}`}>
          <Dots />
          <span className="t-eyebrow">{TYPING_LABEL[typing]}</span>
        </div>
      ) : null}
    </div>
  );
}
