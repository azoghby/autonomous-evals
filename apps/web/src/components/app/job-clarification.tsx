"use client";
import { useState } from "react";
import { api, errMsg, when } from "@/lib/client/api";
import type { MessageView } from "@/lib/client/types";
import { Btn, cx, Field, Glass, Textarea } from "./ui";

const ROLE_LABEL: Record<string, string> = { customer: "You", commercial: "Commercial agent", operator: "Operator", system: "System" };

export function Clarification({ jobId, messages, canReply, onSent }: { jobId: string; messages: MessageView[]; canReply: boolean; onSent: () => Promise<void> }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!answer.trim()) { setError("Write an answer first."); return; }
    setBusy(true); setError(null);
    try {
      await api(`/api/jobs/${jobId}/messages`, { method: "POST", json: { answer } });
      setAnswer("");
      await onSent();
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }

  const thread = (
    <ol className="space-y-3" aria-label="Conversation">
      {messages.map((m) => (
        <li key={m.id} className={cx("flex", m.role === "customer" ? "justify-end" : "justify-start")}>
          <div className={cx("max-w-[85%] rounded-3xl border px-4 py-2.5 text-sm",
            m.role === "customer" ? "border-coral/40 bg-coral/15" : m.role === "system" ? "border-glass-border bg-transparent text-cream/60 italic" : "border-glass-border bg-glass-strong")}>
            <div className="mb-0.5 text-[11px] uppercase tracking-wide text-cream/50">{ROLE_LABEL[m.role] ?? m.role} · {when(m.createdAt)}</div>
            <div className="whitespace-pre-wrap">{m.body}</div>
          </div>
        </li>
      ))}
    </ol>
  );
  if (!canReply) return thread;

  return (
    <Glass>
      <h2 className="mb-1 text-lg font-semibold">We need a bit more detail</h2>
      <p className="mb-4 text-sm text-cream/70">The commercial agent has questions before it can quote you.</p>
      {messages.length ? thread : <p className="text-sm text-cream/60">Waiting for the agent&apos;s questions...</p>}
      <form onSubmit={send} className="mt-5 space-y-3">
        <Field label="Your answer" error={error ?? undefined}>
          <Textarea className="min-h-24" value={answer} onChange={(e) => setAnswer(e.target.value)} />
        </Field>
        <Btn type="submit" loading={busy}>Send answer</Btn>
      </form>
    </Glass>
  );
}
