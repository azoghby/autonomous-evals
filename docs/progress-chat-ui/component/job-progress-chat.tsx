"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { when } from "@/lib/client/api";
import { ProgressChatError, type ChatExchange, type ChatPoll, type ChatReply, type ProgressChatTransport } from "@/lib/client/progress-chat";
import { Block, Textarea } from "./ui";

const button = "min-h-11 rounded-full px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream disabled:cursor-not-allowed disabled:opacity-40";
const action = `${button} bg-white/[0.07] text-cream hover:bg-white/[0.12]`;
type Pending = { messageId: string; question: string };
type LocalExchange = ChatExchange & { question?: string };

function Reply({ reply }: { reply: ChatReply }) {
  return <>
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-cream/90">{reply.text}</p>
    <p className="mt-2 text-xs text-cream/65">Recorded as of <time dateTime={reply.asOf}>{when(reply.asOf)}</time></p>
    {reply.unknowns.length > 0 && <ul aria-label="What is not known" className="mt-2 list-disc space-y-1 pl-4 text-xs text-cream/70">
      {reply.unknowns.map((unknown, i) => <li key={i}>{unknown}</li>)}
    </ul>}
    {reply.evidenceRefs.length > 0 && <details className="mt-2 text-xs text-cream/70">
      <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-cream">Recorded evidence references ({reply.evidenceRefs.length})</summary>
      <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto break-all">{reply.evidenceRefs.map(ref => <li key={ref}>{ref}</li>)}</ul>
    </details>}
  </>;
}

/** Key by job AND session lifetime at the caller. No local/session storage. */
export function JobProgressChat({ jobId, transport }: { jobId: string; transport?: ProgressChatTransport }) {
  const id = useId();
  const [messages, setMessages] = useState<LocalExchange[]>([]);
  const [snapshot, setSnapshot] = useState<ChatPoll | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [sendError, setSendError] = useState("");
  const [pollError, setPollError] = useState(false);
  const [locked, setLocked] = useState<"unauthenticated" | "not_found" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const after = useRef(0);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const historyBusy = useRef(false);
  const lockedRef = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const nearEnd = useRef(true);

  function invalidate(error: unknown) {
    if (!(error instanceof ProgressChatError) || (error.code !== "unauthenticated" && error.code !== "not_found")) return false;
    lockedRef.current = true;
    controller.current?.abort();
    setLocked(error.code);
    setMessages([]); setSnapshot(null); setDraft(""); setPending(null);
    setSendError(""); setHistoryError(false); setPollError(false);
    return true;
  }
  function merge(rows: LocalExchange[]) {
    setMessages(previous => {
      const byId = new Map(previous.map(row => [row.messageId, row]));
      for (const row of rows) byId.set(row.messageId, { ...byId.get(row.messageId), ...row });
      return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
    });
  }
  async function loadHistory(epoch = generation.current) {
    const signal = controller.current?.signal;
    if (!transport || !signal || signal.aborted || lockedRef.current || historyBusy.current) return;
    historyBusy.current = true; setLoading(true); setHistoryError(false);
    try {
      const page = await transport.history({ jobId, afterSequence: after.current, limit: 20 }, signal);
      if (epoch !== generation.current || signal.aborted) return;
      merge(page.messages); after.current = page.nextAfterSequence;
      setMore(page.messages.length === 20);
    } catch (error) {
      if (epoch === generation.current && !signal.aborted && !invalidate(error)) setHistoryError(true);
    } finally {
      if (epoch === generation.current) { historyBusy.current = false; setLoading(false); }
    }
  }
  useEffect(() => {
    const epoch = ++generation.current;
    const ctrl = new AbortController(); controller.current = ctrl;
    lockedRef.current = false; busy.current = false; historyBusy.current = false; after.current = 0;
    setMessages([]); setSnapshot(null); setDraft(""); setPending(null); setSending(false);
    setLocked(null); setSendError(""); setHistoryError(false); setPollError(false); setMore(false);
    setAnnouncement("");
    if (!transport) return () => { ctrl.abort(); generation.current++; };
    void loadHistory(epoch);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor: string | undefined;
    async function poll() {
      if (!transport || ctrl.signal.aborted) return;
      try {
        const next = await transport.poll({ jobId, ...(cursor ? { cursor } : {}) }, ctrl.signal);
        if (epoch !== generation.current || ctrl.signal.aborted) return;
        cursor = next.cursor;
        setPollError(false);
        setSnapshot(previous => ({ ...next, reply: next.reply ?? previous?.reply }));
        if (next.changed) setAnnouncement("Recorded evaluation progress updated.");
      } catch (error) {
        if (epoch === generation.current && !ctrl.signal.aborted && !invalidate(error)) setPollError(true);
      } finally {
        if (epoch === generation.current && !ctrl.signal.aborted) timer = setTimeout(() => void poll(), 3_000);
      }
    }
    void poll();
    return () => { ctrl.abort(); if (timer) clearTimeout(timer); generation.current++; };
    // All requests belong to this transport/job generation; closures cannot write into its successor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, transport, transport?.authScopeKey]);

  useEffect(() => {
    if (nearEnd.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages.length, sending]);

  async function send(request: Pending) {
    const signal = controller.current?.signal;
    if (!transport || !signal || signal.aborted || busy.current || lockedRef.current) return;
    const epoch = generation.current;
    busy.current = true; setSending(true); setPending(request); setSendError("");
    try {
      const response = await transport.send({ jobId, ...request }, signal);
      if (epoch !== generation.current || signal.aborted) return;
      merge([{ ...response, question: request.question }]);
      setPending(null); setDraft(""); setAnnouncement("Progress answer received.");
      textarea.current?.focus();
    } catch (error) {
      if (epoch !== generation.current || signal.aborted || invalidate(error)) return;
      setSendError(error instanceof ProgressChatError && error.code === "conflict"
        ? "This question ID has already been used. Discard this attempt and ask again."
        : "Could not confirm your answer. Retry uses the same question ID to avoid duplicates.");
    } finally {
      if (epoch === generation.current) { busy.current = false; setSending(false); }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || pending || sending) return;
    if (question.length > 4_000 || new TextEncoder().encode(question).length > 8_000) {
      setSendError("Keep your question within 4,000 characters and 8,000 UTF-8 bytes."); return;
    }
    void send({ messageId: crypto.randomUUID(), question });
  }

  return <Block title="Private progress conversation">
    <p className="max-w-2xl text-sm leading-relaxed text-cream/70">Ask about recorded progress, findings, blockers or evaluation costs. Questions do not change or resume the evaluation.</p>
    <p className="mt-2 text-xs leading-relaxed text-cream/65">Do not include credentials. Submitted question text stays in this tab; saved replies appear after reload when chat is connected.</p>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    {!transport ? <p role="status" className="mt-5 text-sm text-cream/80">Progress chat is not connected yet. Job status remains available above.</p>
      : locked ? <p role="alert" className="mt-5 text-sm text-cream/80">{locked === "unauthenticated"
        ? <><a className="underline focus-visible:outline-2 focus-visible:outline-cream" href={`/signin?next=${encodeURIComponent(`/jobs/${jobId}`)}`}>Sign in again</a> to view your private replies.</>
        : "This job is no longer available to your account."}</p>
      : <div className="mt-5 space-y-5">
        <div className="border-b border-white/10 pb-5">
          <h3 className="mb-2 text-sm font-medium">Latest recorded progress</h3>
          {snapshot?.reply ? <Reply reply={snapshot.reply} /> : <p className="text-sm text-cream/70">{pollError ? "Progress updates are temporarily unavailable." : "Loading recorded progress…"}</p>}
          {snapshot?.activity ? <p className="mt-3 text-sm text-cream/85">{snapshot.activity.kind === "acquiring_data" ? "Acquiring evaluation data" : "Waiting for expert input"} · Recorded <time dateTime={snapshot.activity.asOf}>{when(snapshot.activity.asOf)}</time></p>
            : <p className="mt-3 text-xs text-cream/65">Detailed data acquisition and expert waiting status is unavailable.</p>}
          {pollError && snapshot && <p role="status" className="mt-3 text-xs text-coral">Updates interrupted. Showing the last recorded snapshot; retrying automatically.</p>}
        </div>
        <div ref={scroll} tabIndex={0} role="region" aria-label="Private reply history" className="max-h-[28rem] overflow-y-auto overscroll-contain rounded-xl focus-visible:outline-2 focus-visible:outline-cream" onScroll={event => {
          const element = event.currentTarget; nearEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}>
          {loading && messages.length === 0 && <p role="status" className="py-4 text-sm text-cream/70">Loading saved replies…</p>}
          {!loading && !historyError && messages.length === 0 && <p className="py-4 text-sm text-cream/70">No saved replies yet. Ask “What progress is recorded?” to start.</p>}
          <ol className="space-y-5" aria-label="Conversation">
            {messages.map(message => <li key={message.messageId} className="min-w-0 space-y-3 border-b border-white/10 pb-5">
              {message.question && <div className="ml-auto max-w-[95%] rounded-xl bg-white/[0.06] px-4 py-3 sm:max-w-[85%]">
                <p className="mb-1 text-xs font-medium text-cream/70">You · this tab only</p>
                <p className="whitespace-pre-wrap break-words text-sm text-cream">{message.question}</p>
              </div>}
              <div className="pr-2"><p className="mb-1 text-xs font-medium text-coral">Evaluation progress</p><Reply reply={message.reply} /></div>
            </li>)}
          </ol>
        </div>
        {historyError && <p role="alert" className="text-sm text-coral">Could not load saved replies. <button type="button" className="underline focus-visible:outline-2 focus-visible:outline-cream" onClick={() => void loadHistory()}>Retry history</button></p>}
        {more && !historyError && <button type="button" className={action} disabled={loading} onClick={() => void loadHistory()}>{loading ? "Loading replies…" : "Load next replies"}</button>}
        <form onSubmit={submit} className="space-y-3">
          <label htmlFor={`${id}-question`} className="block text-sm font-medium">Ask about this evaluation</label>
          <Textarea ref={textarea} id={`${id}-question`} aria-describedby={`${id}-help ${id}-limit`} value={draft} onChange={event => setDraft(event.target.value)} maxLength={4_000} disabled={sending || !!pending} placeholder="What progress is recorded?" rows={3} />
          <div className="flex flex-wrap justify-between gap-2 text-xs text-cream/65"><p id={`${id}-help`}>Enter adds a line. Use Send question to submit.</p><p id={`${id}-limit`}>{draft.length.toLocaleString()} / 4,000 characters</p></div>
          {pending && <p role="status" className="text-sm text-cream/80">{sending ? "Checking recorded evaluation progress…" : "Question awaiting confirmation."}</p>}
          {sendError && <p role="alert" className="text-sm text-coral">{sendError}</p>}
          <div className="flex flex-wrap gap-3">
            <button type="submit" className={`${button} bg-coral text-navy-deep hover:bg-cream`} disabled={!draft.trim() || sending || !!pending}>Send question</button>
            {pending && !sending && <>
              <button type="button" className={action} onClick={() => void send(pending)}>Retry question</button>
              <button type="button" className={action} onClick={() => { setPending(null); setSendError(""); textarea.current?.focus(); }}>Discard attempt</button>
            </>}
          </div>
        </form>
      </div>}
  </Block>;
}
