"use client";
import { useState } from "react";
import { api, errMsg, when } from "@/lib/client/api";
import type { MessageView } from "@/lib/client/types";
import { Button, Field } from "@/components/ui";
import { cx } from "./ui";
import { Panel } from "./page-parts";

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
      {messages.map((m) => {
        const mine = m.role === "customer";
        return (
          <li key={m.id} className={cx(
            "rounded-[4px] border px-4 py-3",
            mine ? "border-line bg-transparent sm:ml-10" : "border-line-2 bg-bg-band border-l-2 border-l-accent sm:mr-10",
            m.role === "system" && "border-l-line-3 text-subtle",
          )}>
            <div className="t-eyebrow mb-2 flex flex-wrap gap-x-3 text-subtle">
              <span className={mine ? "text-fg-2" : "text-accent-text"}>{ROLE_LABEL[m.role] ?? m.role}</span>
              <span>{when(m.createdAt)}</span>
            </div>
            <div className={cx("whitespace-pre-wrap text-[15px] leading-relaxed", mine ? "text-fg-2" : "text-fg")}>{m.body}</div>
          </li>
        );
      })}
    </ol>
  );
  if (!canReply) return thread;

  return (
    <Panel title="Clarification">
      <h2 className="t-h3 text-fg">We need a bit more detail</h2>
      <p className="mt-2 text-[15px] text-muted">The commercial agent has questions before it can quote you.</p>
      <div className="mt-6">
        {messages.length ? thread : <p className="text-sm text-subtle">Waiting for the agent&apos;s questions...</p>}
      </div>
      <form onSubmit={send} className="mt-8 space-y-4 border-t border-line pt-6">
        <Field id="answer" multiline rows={4} label="Your answer" error={error ?? undefined} value={answer} onChange={(e) => setAnswer(e.target.value)} />
        <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Send answer"}</Button>
      </form>
    </Panel>
  );
}
