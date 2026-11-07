"use client";
import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { Button, Chip, ErrorState, Field, Surface, Spinner } from "@/components/ui";
import { api, ApiError, dollars } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import { MAX_ANSWER_CHARS } from "@ae/core/contracts/experts";

interface Q { domain: string; purpose: string; questions: string[]; honorariumCents: number; mode: string; expiresAt: string }

export function Questionnaire({ token }: { token: string }) {
  const path = `/api/expert/r/${encodeURIComponent(token)}`;
  const { data, error, loading, reload } = useFetch<Q>(path);
  const [answers, setAnswers] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (loading) return <div className="flex justify-center py-24"><Spinner size={28} label="Loading questions" /></div>;
  if (done || error?.status === 409) {
    return (
      <Surface strong role="status" className="flex flex-col items-center gap-3 px-6 py-14 text-center">
        <CircleCheck className="text-ok" size={36} aria-hidden />
        <h1 className="text-2xl font-semibold">Thank you</h1>
        <p className="max-w-sm text-sm text-muted">
          {done ? "Your answers are in. We will pay your honorarium manually and email you when it is sent." : "These answers were already submitted."}
        </p>
      </Surface>
    );
  }
  if (error || !data) {
    const gone = error?.status === 404 || error?.status === 410;
    return (
      <ErrorState title={gone ? "This link is no longer valid" : "Could not load the questions"}
        message={error?.message ?? "Unknown error"}
        action={gone ? undefined : <Button variant="outline" onClick={() => void reload()}>Try again</Button>} />
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!data) return;
    const payload = data.questions
      .map((_, i) => ({ questionIndex: i, answer: (answers[i] ?? "").trim() }))
      .filter((a) => a.answer);
    if (payload.length === 0) { setSubmitError("Answer at least one question."); return; }
    setSending(true); setSubmitError(null);
    try {
      await api(path, { method: "POST", json: { answers: payload } });
      setDone(true);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally { setSending(false); }
  }

  if (data.mode === "call") {
    return (
      <div className="space-y-6">
        <header className="space-y-3">
          <Chip tone="info" dot>{data.domain}</Chip>
          <h1 className="text-3xl font-semibold tracking-tight">Book a call, {dollars(data.honorariumCents)} honorarium</h1>
          <p className="text-sm text-muted">{data.purpose}</p>
          <Button href={`/expert/book/${encodeURIComponent(token)}`} size="lg">Book a call</Button>
          <p className="text-xs text-subtle">Link expires {new Date(data.expiresAt).toLocaleDateString()}.</p>
        </header>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <header className="space-y-3">
        <Chip tone="info" dot>{data.domain}</Chip>
        <h1 className="text-3xl font-semibold tracking-tight">A few questions, {dollars(data.honorariumCents)} honorarium</h1>
        <p className="text-sm text-muted">{data.purpose}</p>
        {data.mode === "call" && (
          <div className="flex flex-wrap items-center gap-3">
            <Button href={`/expert/book/${encodeURIComponent(token)}`} size="lg">Book a call</Button>
            <span className="text-xs text-subtle">Prefer to talk? Pick a time instead, or answer in writing below.</span>
          </div>
        )}
        <p className="text-xs text-subtle">
          These questions were prepared by an AI agent at Autonomous Evals. Your answers are stored by us, used as reference material for evaluations, and never attributed to you by name without your consent. Skip any you prefer not to answer.
        </p>
      </header>
      {data.questions.map((q, i) => (
        <Surface key={i} className="p-5">
          <Field id={`q${i}`} multiline rows={5} label={`${i + 1}. ${q}`} maxLength={MAX_ANSWER_CHARS}
            value={answers[i] ?? ""} onChange={(e) => setAnswers((a) => { const n = [...a]; n[i] = e.target.value; return n; })} />
        </Surface>
      ))}
      {submitError && <p role="alert" className="text-sm text-danger">{submitError}</p>}
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" size="lg" disabled={sending}>{sending ? "Submitting..." : "Submit answers"}</Button>
        <p className="text-xs text-subtle">Link expires {new Date(data.expiresAt).toLocaleDateString()}.</p>
      </div>
    </form>
  );
}
