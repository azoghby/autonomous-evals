"use client";
import { useState } from "react";
import { api, errMsg, when } from "@/lib/client/api";
import type { MessageView } from "@/lib/client/types";
import { AnimatePresence, motion } from "motion/react";
import { Block, Btn, cx, Field, Textarea } from "./ui";
import { EASE } from "./motion";

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
    <ol className="space-y-5" aria-label="Conversation">
      <AnimatePresence initial={false}>
        {messages.map((m) => (
          <motion.li key={m.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: EASE }}
            className={cx("max-w-[85%] text-sm", m.role === "customer" ? "ml-auto border-r border-line-strong pr-4 text-right" : "border-l border-line pl-4", m.role === "system" && "italic text-subtle")}>
            <div className="mb-0.5 text-[11px] uppercase tracking-[0.12em] text-subtle">{ROLE_LABEL[m.role] ?? m.role} · {when(m.createdAt)}</div>
            <div className="whitespace-pre-wrap leading-relaxed text-fg/90">{m.body}</div>
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
  if (!canReply) return thread;

  return (
    <Block>
      <h2 className="mb-1 text-lg font-medium">We need a bit more detail</h2>
      <p className="mb-6 text-sm text-muted">The commercial agent has questions before it can quote you.</p>
      {messages.length ? thread : <p className="text-sm text-subtle">Waiting for the agent&apos;s questions...</p>}
      <form onSubmit={send} className="mt-8 space-y-4">
        <Field label="Your answer" error={error ?? undefined}>
          <Textarea className="min-h-24" value={answer} onChange={(e) => setAnswer(e.target.value)} />
        </Field>
        <Btn type="submit" loading={busy}>Send answer</Btn>
      </form>
    </Block>
  );
}
