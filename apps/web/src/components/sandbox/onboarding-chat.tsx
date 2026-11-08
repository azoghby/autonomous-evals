"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui";

interface Turn { role: "customer" | "agent"; text: string }
interface HistoryResponse { conversationId: string | null; transcript: Array<{ role: string; text: string }> }
interface ReplyResponse { reply: string; conversationId: string; status: string; error?: string }

const GREETING: Turn = {
  role: "agent",
  text: "Hi, I'm Standard Evals' onboarding agent (an AI). Tell me about the agent you want to test: its endpoint or model and system prompt, and its tools (an OpenAPI spec, or try the Acme sample world). Please don't paste API keys.",
};

/** Collapsible "Ask the onboarding agent" panel. Talks to POST /api/sandbox/assistant. */
export function OnboardingChat() {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([GREETING]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    fetch("/api/sandbox/assistant")
      .then((r) => (r.ok ? (r.json() as Promise<HistoryResponse>) : null))
      .then((h) => {
        if (!h?.conversationId) return;
        setConversationId(h.conversationId);
        const past = h.transcript.filter((t): t is Turn => t.role === "customer" || t.role === "agent");
        if (past.length > 0) setTurns(past);
      })
      .catch(() => {});
  }, [open]);

  useEffect(() => { endRef.current?.scrollIntoView?.({ block: "end" }); }, [turns, busy]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    setError(null);
    setBusy(true);
    setTurns((t) => [...t, { role: "customer", text: message }]);
    try {
      const res = await fetch("/api/sandbox/assistant", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, ...(conversationId ? { conversationId } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<ReplyResponse>;
      if (!res.ok || !data.reply) { setError(data.error ?? "Something went wrong. Please try again."); return; }
      setConversationId(data.conversationId ?? conversationId);
      setTurns((t) => [...t, { role: "agent", text: data.reply! }]);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Onboarding assistant" className="mt-8 max-w-3xl rounded-[4px] border border-line-2 bg-bg-raised">
      <button
        type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-[15px] text-fg hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span>Ask the onboarding agent</span>
        <span aria-hidden className="text-muted">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div id={panelId} className="border-t border-line-2 p-4">
          <ol aria-live="polite" className="flex max-h-96 flex-col gap-3 overflow-y-auto pr-1">
            {turns.map((t, i) => (
              <li key={i} className={t.role === "customer" ? "self-end text-right" : "self-start"}>
                <p className="t-eyebrow mb-1 text-subtle">{t.role === "customer" ? "You" : "Onboarding agent"}</p>
                <p className={`whitespace-pre-wrap text-[15px] leading-relaxed ${t.role === "customer" ? "text-fg" : "text-fg-2"}`}>{t.text}</p>
              </li>
            ))}
            {busy && <li className="text-sm text-muted">Thinking…</li>}
            <div ref={endRef} />
          </ol>
          {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
          <form onSubmit={send} className="mt-4 flex flex-col gap-2">
            <label htmlFor={`${panelId}-msg`} className="text-[13px] leading-none text-fg-2">Your message</label>
            <textarea
              id={`${panelId}-msg`} className="input" rows={3} maxLength={8000} value={draft} disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(e as unknown as FormEvent); }}
              placeholder="e.g. My agent is gpt-5-mini with this system prompt… use the Acme sample world."
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-subtle">Never share API keys here. We only start runs you asked for.</p>
              <Button type="submit" size="sm" disabled={busy || !draft.trim()}>Send</Button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
