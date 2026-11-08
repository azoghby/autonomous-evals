"use client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readAttachments } from "./attachments";
import { Composer, type ComposerApi } from "./Composer";
import { NovaActionsContext, type NovaActions, type TurnRequest } from "./context";
import { IconDown, IconX } from "./icons";
import { AssistantMessage, ThinkingRow, UserMessage } from "./Message";
import type { ChatAttachment, ConversationStatus, NovaUIMessage } from "./nova-types";
import { ATTACHMENT_LABEL } from "./nova-types";
import { NovaEmpty } from "./NovaEmpty";
import type { CostAnswer } from "./parts/CostEstimate";
import { RunRail, RunStrip } from "./RunRail";

const API = "/api/sandbox/assistant";
const POLL_MS = 5_000;
const NEAR_BOTTOM_PX = 140;

interface HistoryResponse { conversationId: string | null; status: ConversationStatus; messages: NovaUIMessage[] }

/** Keeps local ids where the server returns the same message in the same slot, so nothing remounts or re-animates. */
export function reconcile(local: NovaUIMessage[], server: NovaUIMessage[]): NovaUIMessage[] {
  return server.map((m, i) => {
    const l = local[i];
    return l && l.role === m.role ? { ...m, id: l.id } : m;
  });
}

export function errorText(err: Error | undefined): string | null {
  if (!err) return null;
  try {
    const j = JSON.parse(err.message) as { error?: string };
    if (j.error === "rate_limited") return "You're sending messages quickly. Wait a minute, then try again.";
    if (j.error === "Authentication required") return "Your session ended. Sign in again to keep talking to Nova.";
    if (typeof j.error === "string") return j.error;
  } catch { /* not JSON */ }
  return err.message || "Something went wrong. Try again.";
}

const fileLine = (f: ChatAttachment) => `[attached: ${f.name} (${ATTACHMENT_LABEL[f.kind]}, ${Math.max(1, Math.round(f.content.length / 1000))} KB)]`;

function answerAfter(messages: NovaUIMessage[], i: number): CostAnswer {
  const next = messages.slice(i + 1).find((m) => m.role === "user");
  const t = next?.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n") ?? "";
  return t.includes("Confirmed the run.") ? "confirmed" : t.includes("Cancelled the run.") ? "cancelled" : null;
}

export function NovaChat({ variant = "page" }: { variant?: "page" | "panel" }) {
  const conversationRef = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerApi>(null);
  const stickRef = useRef(true);
  const initialIds = useRef<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [convStatus, setConvStatus] = useState<ConversationStatus>("collecting");
  const [thinking, setThinking] = useState("Reading your message");
  const [announce, setAnnounce] = useState("");
  const [showJump, setShowJump] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const transport = useMemo(() => new DefaultChatTransport<NovaUIMessage>({
    api: API,
    prepareSendMessagesRequest: ({ body }) => ({
      body: { ...((body as { turn?: TurnRequest } | undefined)?.turn ?? {}), ...(conversationRef.current ? { conversationId: conversationRef.current } : {}) },
    }),
  }), []);

  const chat = useChat<NovaUIMessage>({
    transport,
    experimental_throttle: 40,
    onData: (part) => { if (part.type === "data-thinking") setThinking(part.data.label); },
    onFinish: ({ message }) => {
      const id = message.metadata?.conversationId;
      if (id) conversationRef.current = id;
      if (message.metadata?.status) setConvStatus(message.metadata.status);
      const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
      if (text) setAnnounce(`Nova: ${text}`);
      void refresh(false);
    },
    onError: () => { void refresh(false); },
  });
  const { messages, setMessages, sendMessage, status, stop, error, clearError } = chat;
  const streaming = status === "submitted" || status === "streaming";

  const refresh = useCallback(async (advance: boolean) => {
    try {
      const res = await fetch(`${API}${advance ? "?advance=1" : ""}`, { cache: "no-store" });
      if (res.status === 401) { setLoadError("Your session ended. Sign in again to keep talking to Nova."); return; }
      if (!res.ok) return;
      const h = (await res.json()) as HistoryResponse;
      if (h.conversationId) conversationRef.current = h.conversationId;
      setConvStatus((prev) => {
        if (prev !== h.status && h.status === "reported") setAnnounce("Your run finished. Results are below.");
        return h.status;
      });
      setMessages((local) => reconcile(local, h.messages));
    } catch { /* keep what we have; the next poll retries */ }
  }, [setMessages]);

  // history
  useEffect(() => {
    let live = true;
    fetch(API, { cache: "no-store" })
      .then(async (r) => {
        if (!live) return;
        if (r.status === 401) { setLoadError("Sign in to talk to Nova."); return; }
        if (!r.ok) { setLoadError("Couldn't load your conversation. Refresh to try again."); return; }
        const h = (await r.json()) as HistoryResponse;
        if (!live) return;
        conversationRef.current = h.conversationId;
        setConvStatus(h.status);
        initialIds.current = new Set(h.messages.map((m) => m.id));
        setMessages(h.messages);
      })
      .catch(() => { if (live) setLoadError("Couldn't load your conversation. Refresh to try again."); })
      .finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [setMessages]);

  // live build/run: poll (and nudge the conversation forward) while something is in flight
  useEffect(() => {
    if (streaming || (convStatus !== "building" && convStatus !== "running")) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") void refresh(true); }, POLL_MS);
    return () => clearInterval(t);
  }, [convStatus, streaming, refresh]);

  // stick to bottom while the reader is there
  useEffect(() => {
    const el = logRef.current;
    if (!el || !stickRef.current) return;
    const smooth = window.matchMedia("(prefers-reduced-motion: no-preference)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && loaded ? "smooth" : "auto" });
  }, [messages, status, loaded]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stickRef.current = near;
    setShowJump(!near);
  };
  const jump = () => { stickRef.current = true; logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }); };

  const send = useCallback((req: TurnRequest, display: string) => {
    if (streaming) return;
    clearError();
    stickRef.current = true;
    setThinking(req.action === "confirm" ? "Building your sandbox" : req.attachments?.length ? "Reading your files" : "Reading your message");
    void sendMessage({ text: display, metadata: { at: new Date().toISOString() } }, { body: { turn: req } });
  }, [streaming, clearError, sendMessage]);

  const sendFiles = useCallback(async (list: FileList | File[]) => {
    const res = await readAttachments(list);
    if (res.files.length) send({ attachments: res.files }, res.files.map(fileLine).join("\n"));
    return res.errors;
  }, [send]);

  const actions = useMemo<NovaActions>(() => ({ send, sendFiles, busy: streaming }), [send, sendFiles, streaming]);

  const onComposerSend = (text: string, files: ChatAttachment[]) => {
    send({ ...(text ? { message: text } : {}), ...(files.length ? { attachments: files } : {}) }, [text, ...files.map(fileLine)].filter(Boolean).join("\n"));
  };

  const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
  const last = messages.at(-1);
  const awaitingReply = streaming && (last?.role === "user" || !last?.parts.some((p) => p.type === "text" && p.text));
  const banner = loadError ?? errorText(error);

  const log = (
    <div className="nv-log" ref={logRef} onScroll={onScroll}>
      <div className="nv-log-inner">
        {!loaded ? (
          <div className="nv-skel-stack pt-6" aria-hidden="true"><span className="nv-skel" style={{ width: "40%" }} /><span className="nv-skel" style={{ width: "64%" }} /></div>
        ) : messages.length === 0 ? (
          <NovaEmpty
            compact={variant === "panel"}
            onPick={(s) => {
              if (s.kind === "send") send({ message: s.text }, s.text);
              else { composer.current?.setText(s.text); composer.current?.openPicker(); }
            }}
          />
        ) : (
          <ol className="m-0 flex list-none flex-col p-0" role="log" aria-label="Conversation with Nova" aria-live="off" aria-busy={streaming}>
            {messages.map((m, i) => {
              const cont = i > 0 && messages[i - 1]!.role === m.role;
              const animate = !initialIds.current.has(m.id);
              if (m.role === "user") return <UserMessage key={m.id} message={m} cont={cont} animate={animate} />;
              const isStreamingMsg = streaming && i === messages.length - 1;
              return (
                <AssistantMessage
                  key={m.id} message={m} cont={cont} animate={animate} streaming={isStreamingMsg}
                  interactive={!streaming && i === lastAssistant && i === messages.length - 1 && convStatus === "collecting"}
                  answer={answerAfter(messages, i)}
                  thinking={isStreamingMsg && !m.parts.some((p) => p.type === "text" && p.text) ? <ThinkingRow label={thinking} /> : undefined}
                />
              );
            })}
            {awaitingReply && last?.role === "user" && (
              <AssistantMessage
                message={{ id: "pending", role: "assistant", parts: [] }} cont={false} animate streaming interactive={false} answer={null}
                thinking={<ThinkingRow label={thinking} />}
              />
            )}
          </ol>
        )}
      </div>
    </div>
  );

  const dock = (
    <div className="nv-dock">
      {showJump && <button type="button" className="nv-jump" onClick={jump}><IconDown />Latest</button>}
      {banner && (
        <div className="nv-alert" role="alert">
          <span>{banner}</span>
          {!loadError && <button type="button" className="nv-x" aria-label="Dismiss" onClick={clearError}><IconX width={12} height={12} /></button>}
        </div>
      )}
      <Composer
        api={composer} streaming={streaming} onSend={onComposerSend} onStop={() => void stop()} disabled={!!loadError || !loaded}
        placeholder={convStatus === "building" || convStatus === "running" ? "Ask Nova about your run" : undefined}
      />
      <p className="nv-fineprint">Never paste API keys. Nova only starts runs you confirm.</p>
    </div>
  );

  const body = (
    <NovaActionsContext.Provider value={actions}>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announce}</div>
      {log}
      {dock}
    </NovaActionsContext.Provider>
  );

  if (variant === "panel") return <div className="nv-root nv-panel">{body}</div>;
  return (
    <div className="nv-page">
      <RunRail status={convStatus} messages={messages} />
      <div className="nv-main">
        <RunStrip status={convStatus} messages={messages} />
        <div className="nv-root">{body}</div>
      </div>
    </div>
  );
}
