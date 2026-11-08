"use client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useState } from "react";
import type { EvalChatHistory, EvalRef, EvalUIMessage } from "@/lib/eval-chat/types";
import { chatPath, fetchHistory } from "./api";
import { Composer } from "./Composer";
import { ActionsProvider } from "./context";
import { EmptyState } from "./EmptyState";
import { Messages, messageHasContent } from "./Messages";

type Props = { evalRef: EvalRef; title: string; autoFocus?: boolean };
type Load = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; history: EvalChatHistory };

/** Loads the stored conversation, then mounts the live chat seeded with it. */
export function EvalChat({ evalRef, title, autoFocus }: Props) {
  const { kind, id } = evalRef;
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    fetchHistory({ kind, id }, ctl.signal)
      .then((history) => setLoad({ phase: "ready", history }))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setLoad({ phase: "error", message: e instanceof Error ? e.message : "Could not load the conversation" });
      });
    return () => ctl.abort();
  }, [kind, id, attempt]);

  if (load.phase === "ready") return <ChatSession evalRef={{ kind, id }} title={load.history.title || title} history={load.history} autoFocus={autoFocus} />;
  return (
    <div className="ec-chat">
      <div className="ec-scrollarea">
        {load.phase === "loading" ? (
          <div className="ec-loading" role="status" aria-label="Loading conversation"><div className="ec-skel" /><div className="ec-skel" data-short="" /><div className="ec-skel" /></div>
        ) : (
          <div className="ec-errbox" role="alert">
            <p className="ec-text"><span className="ec-strong">Could not load this conversation.</span> {load.message}. Check your connection and try again.</p>
            <button type="button" className="ec-btn" data-variant="outline" onClick={() => { setLoad({ phase: "loading" }); setAttempt((a) => a + 1); }}>Try again</button>
          </div>
        )}
      </div>
      <Composer streaming={false} disabled onSend={() => {}} onStop={() => {}} />
    </div>
  );
}

function latestStatusLabel(messages: EvalUIMessage[]): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return null;
  for (let i = last.parts.length - 1; i >= 0; i--) {
    const p = last.parts[i];
    if (p && p.type === "data-status") return p.data.label;
  }
  return null;
}

function ChatSession({ evalRef, title, history, autoFocus }: Props & { history: EvalChatHistory }) {
  const { kind, id } = evalRef;
  const transport = useMemo(
    () =>
      new DefaultChatTransport<EvalUIMessage>({
        api: chatPath({ kind, id }),
        prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages[messages.length - 1] } }),
      }),
    [kind, id],
  );
  const { messages, sendMessage, regenerate, stop, status, error, clearError } = useChat<EvalUIMessage>({ id: `eval-chat:${kind}:${id}`, messages: history.messages, transport });
  const [sendCount, setSendCount] = useState(0);
  const [announce, setAnnounce] = useState("");
  const [prevStatus, setPrevStatus] = useState(status);

  const busy = status === "submitted" || status === "streaming";
  const last = messages[messages.length - 1];
  const waiting = status === "submitted" || (status === "streaming" && last?.role === "assistant" && !messageHasContent(last));
  const thinking = waiting ? (latestStatusLabel(messages) ?? "Thinking…") : null;

  // Adjust-state-during-render: announce when a reply settles (no effect needed).
  if (prevStatus !== status) {
    setPrevStatus(status);
    if ((prevStatus === "streaming" || prevStatus === "submitted") && status === "ready") setAnnounce("Copilot finished replying.");
    else if (status === "error") setAnnounce("The copilot could not reply.");
    else if (busy) setAnnounce("");
  }

  const send = (text: string) => {
    setSendCount((n) => n + 1);
    void sendMessage({ text });
  };
  const retry = () => {
    clearError();
    setSendCount((n) => n + 1);
    void regenerate();
  };

  return (
    <ActionsProvider evalRef={{ kind, id }} initial={history.actions}>
      <div className="ec-chat">
        <Messages messages={messages} thinking={thinking} scrollKey={messages} sendCount={sendCount}>
          {messages.length === 0 ? <EmptyState title={title} suggestions={history.suggestions} disabled={busy} onPick={send} /> : null}
        </Messages>
        <div className="ec-sr" aria-live="polite" role="status">{announce}</div>
        {error ? (
          <div className="ec-errbox" role="alert">
            <p className="ec-text"><span className="ec-strong">The copilot could not reply.</span> {error.message || "Something went wrong"}. Retry, or send a new message.</p>
            <div className="ec-actions">
              <button type="button" className="ec-btn" data-variant="outline" onClick={retry}>Retry</button>
              <button type="button" className="ec-btn" data-variant="ghost" onClick={clearError}>Dismiss</button>
            </div>
          </div>
        ) : null}
        <Composer streaming={busy} autoFocus={autoFocus} onSend={send} onStop={() => void stop()} />
      </div>
    </ActionsProvider>
  );
}
