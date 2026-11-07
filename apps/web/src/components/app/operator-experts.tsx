"use client";
import { useState } from "react";
import { api, dollars, errMsg, when } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import { AnimatePresence } from "motion/react";
import { Banner, Btn, Chip, Empty, ErrorBox, Field, Input, Loading, Textarea } from "./ui";
import { Stagger, StaggerItem } from "./motion";

interface Request { id: string; domain: string; purpose: string; questions: string[]; maxBudgetCents: number; status: string; jobId: string | null; createdAt: string }
interface Expert { id: string; name: string; email: string; title: string; organization: string | null; domains: string[]; source: string; status: string; rateCents: number | null }
interface Engagement {
  id: string; requestId: string; expertId: string; mode: string; status: string; honorariumCents: number; paidAt: string | null;
  answeredAt: string | null; recordingConsent: boolean; scheduledAt: string | null; draftStatus: string | null; createdAt: string; answers: { questionIndex: number; answer: string }[] | null;
}
interface Slot { id: string; startsAt: string; durationMin: number; takenByEngagementId: string | null; expertName: string | null }
interface Overview {
  requests: Request[]; experts: Expert[]; engagements: Engagement[];
  counts: { requests: number; experts: number; engagements: number; responses: number; suppressions: number };
  honorariaOwedCents: number; honorariaPaidCents: number; coldContactsToday: number; coldContactLimit: number;
}

const tone = (s: string) => (s === "answered" ? "warn" : s === "paid" ? "ok" : s === "cancelled" || s === "opted_out" ? "muted" : "info") as "warn" | "ok" | "muted" | "info";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-4 border-t border-line pt-6"><h2 className="text-xs font-medium uppercase tracking-[0.14em] text-subtle">{title}</h2>{children}</section>;
}

function CallSlots() {
  const { data, error, loading, reload } = useFetch<{ slots: Slot[] }>("/api/operator/experts/slots");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const local = String(f.get("startsAt") ?? "");
    const d = new Date(local);
    if (!local || Number.isNaN(d.getTime())) { setMsg({ ok: false, text: "Pick a start time." }); return; }
    setBusy("add"); setMsg(null);
    try {
      const r = await api<{ created: number; skippedDuplicates: number }>("/api/operator/experts/slots", {
        method: "POST", json: { startsAt: d.toISOString(), durationMin: Number(f.get("durationMin") || 15) },
      });
      setMsg({ ok: true, text: `Added ${r.created} slot${r.created === 1 ? "" : "s"}${r.skippedDuplicates ? ` (${r.skippedDuplicates} duplicate skipped)` : ""}.` });
      form.reset(); await reload();
    } catch (e2) { setMsg({ ok: false, text: errMsg(e2) }); } finally { setBusy(null); }
  }
  async function remove(id: string) {
    setBusy(id); setMsg(null);
    try { await api(`/api/operator/experts/slots/${id}`, { method: "DELETE" }); await reload(); }
    catch (e2) { setMsg({ ok: false, text: errMsg(e2) }); } finally { setBusy(null); }
  }
  return (
    <Section title="Call slots">
      <form onSubmit={add} className="flex flex-wrap items-end gap-4">
        <Field label="Start (your local time)"><Input name="startsAt" type="datetime-local" required /></Field>
        <Field label="Minutes"><Input name="durationMin" type="number" min={10} max={120} step={5} defaultValue={15} className="w-24" /></Field>
        <Btn type="submit" loading={busy === "add"}>Add slot</Btn>
      </form>
      {msg && <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-sm text-muted" : "text-sm text-accent-bright"}>{msg.text}</p>}
      {loading ? <Loading label="Loading slots" /> : error || !data ? <ErrorBox message={error?.message ?? "Unknown error"} onRetry={() => void reload()} /> :
        data.slots.length === 0 ? <p className="text-sm text-muted">No upcoming slots.</p> : (
          <ul>{data.slots.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3 text-sm">
              <span className="tabular-nums">{when(s.startsAt)} <span className="text-xs text-subtle">· {s.durationMin} min</span></span>
              {s.takenByEngagementId
                ? <Chip tone="info">Booked: {s.expertName ?? "expert"}</Chip>
                : <Btn variant="ghost" loading={busy === s.id} onClick={() => void remove(s.id)}>Delete</Btn>}
            </li>
          ))}</ul>
        )}
    </Section>
  );
}

function EngagementNotes({ engagement, onSaved }: { engagement: Engagement; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true); setMsg(null);
    try {
      await api(`/api/operator/experts/engagements/${engagement.id}/notes`, {
        method: "POST", json: { text: String(f.get("text") ?? "").trim(), kind: String(f.get("kind")) === "transcript" ? "transcript" : "notes" },
      });
      form.reset(); setMsg({ ok: true, text: "Saved." }); onSaved();
    } catch (e2) { setMsg({ ok: false, text: errMsg(e2) }); } finally { setBusy(false); }
  }
  return (
    <details className="text-sm"><summary className="cursor-pointer text-muted">Add call notes</summary>
      <form onSubmit={submit} className="mt-3 space-y-3">
        <Textarea name="text" required rows={4} aria-label="Call notes" />
        <div className="flex flex-wrap items-center gap-4">
          <select name="kind" defaultValue="notes" aria-label="Kind"
            className="rounded-md bg-bg-raised px-3 py-2 text-sm text-fg outline-none ring-1 ring-inset ring-line focus:ring-accent">
            <option value="notes">Notes</option>
            <option value="transcript" disabled={!engagement.recordingConsent}>Transcript{engagement.recordingConsent ? "" : " (no recording consent)"}</option>
          </select>
          <Btn type="submit" loading={busy}>Save</Btn>
          {msg && <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-xs text-muted" : "text-xs text-accent-bright"}>{msg.text}</span>}
        </div>
      </form>
    </details>
  );
}

function NewRequest({ onCreated }: { onCreated: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    setBusy(true); setErr(null);
    try {
      await api("/api/operator/experts/requests", {
        method: "POST",
        json: {
          domain: s("domain"), purpose: s("purpose"),
          questions: s("questions").split("\n").map((q) => q.trim()).filter(Boolean),
          maxBudgetCents: Math.round(Number(s("budget") || "0") * 100),
          ...(s("jobId") ? { jobId: s("jobId") } : {}),
        },
      });
      form.reset(); onCreated();
    } catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  }
  return (
    <div className="pt-4">
      <form onSubmit={submit} className="space-y-4">
        <h3 className="text-sm font-medium">New expert request</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Domain"><Input name="domain" required /></Field>
          <Field label="Honorarium budget (USD)" hint="$0 means no experts can be invited"><Input name="budget" type="number" min={0} step="1" defaultValue={25} /></Field>
        </div>
        <Field label="Purpose" hint="Shown to the expert. Never include customer data."><Input name="purpose" required /></Field>
        <Field label="Questions (one per line, max 8)"><Textarea name="questions" required rows={4} /></Field>
        <Field label="Job id (optional)"><Input name="jobId" placeholder="uuid" /></Field>
        {err && <p role="alert" className="text-sm text-accent-bright">{err}</p>}
        <Btn type="submit" loading={busy}>Create request</Btn>
      </form>
    </div>
  );
}

export function OperatorExperts() {
  const { data, error, loading, reload } = useFetch<Overview>("/api/operator/experts");
  const [requestId, setRequestId] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  if (loading) return <Loading label="Loading experts" />;
  if (error?.status === 401 || error?.status === 403) return <Empty title="Operators only" body="Sign in with an operator account." />;
  if (error || !data) return <ErrorBox message={error?.message ?? "Unknown error"} onRetry={() => void reload()} />;

  const selected = requestId || data.requests[0]?.id || "";
  const expertName = new Map(data.experts.map((e) => [e.id, e.name]));
  const requestDomain = new Map(data.requests.map((r) => [r.id, r.domain]));

  async function act(key: string, fn: () => Promise<string>) {
    setBusyId(key); setNotice(null);
    try { setNotice({ ok: true, text: await fn() }); await reload(); } catch (e) { setNotice({ ok: false, text: errMsg(e) }); } finally { setBusyId(null); }
  }
  const invite = (expertId: string) => act(`i${expertId}`, async () => {
    await api("/api/operator/experts/invite", { method: "POST", json: { requestId: selected, expertId } });
    return "Invite drafted. Approve it in the outreach queue to send it.";
  });
  const markPaid = (id: string) => act(`p${id}`, async () => {
    await api(`/api/operator/experts/engagements/${id}/mark-paid`, { method: "POST" });
    return "Marked paid.";
  });

  return (
    <div className="space-y-10">
      <div className="grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
        {([["Honoraria owed", dollars(data.honorariaOwedCents)], ["Honoraria paid", dollars(data.honorariaPaidCents)], ["Responses", String(data.counts.responses)], ["Cold contacts today", `${data.coldContactsToday}/${data.coldContactLimit}`]] as const).map(([l, v]) => (
          <div key={l}><div className="text-xs text-subtle">{l}</div><div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{v}</div></div>
        ))}
      </div>
      <AnimatePresence>{notice && <Banner key={notice.text} tone={notice.ok ? "ok" : "bad"}>{notice.text}</Banner>}</AnimatePresence>

      <Section title="Requests">
        {data.requests.length === 0 ? <Empty title="No requests yet" body="Create one below, or wait for an agent to emit one." /> : (
          <Stagger as="ul">{data.requests.map((r) => (
            <StaggerItem as="li" key={r.id} className="space-y-2 border-t border-line py-5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1"><strong className="font-medium">{r.domain}</strong><Chip tone={tone(r.status)}>{r.status}</Chip>
                <span className="text-xs text-subtle">budget {dollars(r.maxBudgetCents)} · {when(r.createdAt)}</span></div>
              <p className="text-sm text-muted">{r.purpose}</p>
              <ol className="list-decimal space-y-0.5 pl-5 text-sm text-muted">{r.questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
            </StaggerItem>
          ))}</Stagger>
        )}
        <NewRequest onCreated={() => void reload()} />
      </Section>

      <Section title={`Experts (${data.experts.length})`}>
        {data.requests.length > 0 && (
          <label className="flex flex-wrap items-center gap-3 text-sm">Invite into
            <select value={selected} onChange={(e) => setRequestId(e.target.value)}
              className="rounded-md bg-bg-raised px-4 py-2 text-sm text-fg outline-none ring-1 ring-inset ring-line focus:ring-accent">
              {data.requests.map((r) => <option key={r.id} value={r.id}>{r.domain} ({r.status})</option>)}
            </select></label>
        )}
        {data.experts.length === 0 ? <Empty title="No experts yet" body="Share /experts so professionals can opt in." /> : (
          <Stagger as="ul">{data.experts.map((x) => (
            <StaggerItem as="li" key={x.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1"><strong className="font-medium">{x.name}</strong><Chip tone={tone(x.status)}>{x.status}</Chip><span className="text-xs text-subtle">{x.source}</span></div>
                <div className="text-sm text-muted">{x.title}{x.organization ? `, ${x.organization}` : ""} · {x.domains.join(", ")}</div>
                <div className="text-xs text-subtle">{x.email}</div>
              </div>
              <Btn variant="ghost" disabled={!selected || x.status !== "active"} loading={busyId === `i${x.id}`} onClick={() => void invite(x.id)}>Invite</Btn>
            </StaggerItem>
          ))}</Stagger>
        )}
      </Section>

      <CallSlots />

      <Section title="Engagements">
        {data.engagements.length === 0 ? <Empty title="No engagements" body="Invites appear here once drafted." /> : (
          <Stagger as="ul">{data.engagements.map((e) => (
            <StaggerItem as="li" key={e.id} className="space-y-2 border-t border-line py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <strong className="font-medium">{expertName.get(e.expertId) ?? "Expert"}</strong><span className="text-sm text-muted">on {requestDomain.get(e.requestId) ?? "request"}</span>
                  <Chip tone={tone(e.status)}>{e.status}</Chip>{e.draftStatus && <span className="text-xs text-subtle">email {e.draftStatus}</span>}
                  <span className="text-xs text-subtle">{dollars(e.honorariumCents)}</span>
                  {e.scheduledAt && <span className="text-xs text-subtle">call {when(e.scheduledAt)}</span>}
                </div>
                {e.status === "answered" && <Btn variant="ghost" loading={busyId === `p${e.id}`} onClick={() => void markPaid(e.id)}>Mark paid</Btn>}
              </div>
              <EngagementNotes engagement={e} onSaved={() => void reload()} />
              {e.answers && <details className="text-sm"><summary className="cursor-pointer text-muted">View answers</summary>
                <ol className="mt-2 space-y-2">{e.answers.map((a) => <li key={a.questionIndex}><span className="text-xs text-subtle">Q{a.questionIndex + 1}</span><p className="whitespace-pre-wrap">{a.answer}</p></li>)}</ol></details>}
            </StaggerItem>
          ))}</Stagger>
        )}
      </Section>
    </div>
  );
}
