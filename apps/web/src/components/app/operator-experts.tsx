"use client";
import { useState, type ReactNode } from "react";
import { api, dollars, errMsg, when } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import { AnimatePresence } from "motion/react";
import { Chip as UiChip, Frame } from "@/components/ui";
import { Banner, Btn, Empty, ErrorBox, Field, Input, Loading, Metric, MetricStrip, Section, TableWrap, Textarea, Th, tableCls, tdCls, tdNumCls, trCls } from "./ui";

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

function StatusDot({ tone: t, children }: { tone: "warn" | "ok" | "muted" | "info"; children: ReactNode }) {
  return <UiChip tone={t === "info" ? "neutral" : t} variant="plain" dot>{children}</UiChip>;
}

const tone = (s: string) => (s === "answered" ? "warn" : s === "paid" ? "ok" : s === "cancelled" || s === "opted_out" ? "muted" : "info") as "warn" | "ok" | "muted" | "info";

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
      <form onSubmit={add} className="flex flex-wrap items-end gap-4 rounded-[4px] border border-line-2 bg-bg-raised p-4">
        <Field label="Start (your local time)"><Input name="startsAt" type="datetime-local" required /></Field>
        <Field label="Minutes"><Input name="durationMin" type="number" min={10} max={120} step={5} defaultValue={15} className="!w-24" /></Field>
        <Btn type="submit" loading={busy === "add"}>Add slot</Btn>
      </form>
      {msg && <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-sm text-muted" : "text-sm text-danger"}>{msg.text}</p>}
      {loading ? <Loading label="Loading slots" /> : error || !data ? <ErrorBox message={error?.message ?? "Unknown error"} onRetry={() => void reload()} /> :
        data.slots.length === 0 ? <p className="text-sm text-muted">No upcoming slots.</p> : (
          <TableWrap>
            <table className={`${tableCls} min-w-[480px]`}>
              <thead><tr><Th>Start</Th><Th num>Minutes</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
              <tbody>{data.slots.map((s) => (
                <tr key={s.id} className={trCls}>
                  <td className={`${tdCls} whitespace-nowrap font-mono text-[13px] tabular-nums`}>{when(s.startsAt)}</td>
                  <td className={tdNumCls}>{s.durationMin}</td>
                  <td className={tdCls}>{s.takenByEngagementId ? <UiChip tone="info">Booked: {s.expertName ?? "expert"}</UiChip> : <span className="text-[13px] text-muted">Open</span>}</td>
                  <td className={`${tdCls} text-right`}>{!s.takenByEngagementId && <Btn variant="ghost" size="sm" loading={busy === s.id} onClick={() => void remove(s.id)}>Delete</Btn>}</td>
                </tr>
              ))}</tbody>
            </table>
          </TableWrap>
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
    <details className="text-sm"><summary className="cursor-pointer text-[13px] text-muted hover:text-fg">Add call notes</summary>
      <form onSubmit={submit} className="mt-3 space-y-3">
        <Textarea name="text" required rows={4} aria-label="Call notes" />
        <div className="flex flex-wrap items-center gap-4">
          <select name="kind" defaultValue="notes" aria-label="Kind"
            className="select !w-auto">
            <option value="notes">Notes</option>
            <option value="transcript" disabled={!engagement.recordingConsent}>Transcript{engagement.recordingConsent ? "" : " (no recording consent)"}</option>
          </select>
          <Btn type="submit" loading={busy}>Save</Btn>
          {msg && <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-xs text-muted" : "text-xs text-danger"}>{msg.text}</span>}
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
    <Frame className="p-5 sm:p-6">
      <form onSubmit={submit} className="space-y-4">
        <h3 className="t-h4">New expert request</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Domain"><Input name="domain" required /></Field>
          <Field label="Honorarium budget (USD)" hint="$0 means no experts can be invited"><Input name="budget" type="number" min={0} step="1" defaultValue={25} /></Field>
        </div>
        <Field label="Purpose" hint="Shown to the expert. Never include customer data."><Input name="purpose" required /></Field>
        <Field label="Questions (one per line, max 8)"><Textarea name="questions" required rows={4} /></Field>
        <Field label="Job id (optional)"><Input name="jobId" placeholder="uuid" /></Field>
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        <Btn type="submit" loading={busy}>Create request</Btn>
      </form>
    </Frame>
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
    <div className="space-y-14">
      <MetricStrip>
        {([["Honoraria owed", dollars(data.honorariaOwedCents)], ["Honoraria paid", dollars(data.honorariaPaidCents)], ["Responses", String(data.counts.responses)], ["Cold contacts today", `${data.coldContactsToday}/${data.coldContactLimit}`]] as const).map(([l, v]) => (
          <Metric key={l} label={l} value={v} />
        ))}
      </MetricStrip>
      <AnimatePresence>{notice && <Banner key={notice.text} tone={notice.ok ? "ok" : "bad"}>{notice.text}</Banner>}</AnimatePresence>

      <Section title="Requests">
        {data.requests.length === 0 ? <TableWrap><Empty title="No requests yet" body="Create one below, or wait for an agent to emit one." /></TableWrap> : (
          <ul className="divide-y divide-line rounded-[4px] border border-line-2">{data.requests.map((r) => (
            <li key={r.id} className="space-y-2 p-5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1"><span className="t-h4">{r.domain}</span><StatusDot tone={tone(r.status)}>{r.status}</StatusDot>
                <span className="font-mono text-xs text-subtle">budget {dollars(r.maxBudgetCents)} · {when(r.createdAt)}</span></div>
              <p className="text-sm text-muted">{r.purpose}</p>
              <ol className="list-decimal space-y-0.5 pl-5 text-sm text-muted">{r.questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
            </li>
          ))}</ul>
        )}
        <NewRequest onCreated={() => void reload()} />
      </Section>

      <Section title={`Experts (${data.experts.length})`}>
        {data.requests.length > 0 && (
          <label className="flex flex-wrap items-center gap-3 text-[13px] text-fg-2">Invite into
            <select value={selected} onChange={(e) => setRequestId(e.target.value)} className="select !w-auto max-w-full">
              {data.requests.map((r) => <option key={r.id} value={r.id}>{r.domain} ({r.status})</option>)}
            </select></label>
        )}
        {data.experts.length === 0 ? <TableWrap><Empty title="No experts yet" body="Share /experts so professionals can opt in." /></TableWrap> : (
          <TableWrap>
            <table className={`${tableCls} min-w-[760px]`}>
              <thead><tr><Th>Expert</Th><Th>Role</Th><Th>Domains</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
              <tbody>{data.experts.map((x) => (
                <tr key={x.id} className={`${trCls} h-14`}>
                  <td className={`${tdCls} max-w-[240px]`}>
                    <div className="truncate text-fg" title={x.name}>{x.name}</div>
                    <div className="truncate font-mono text-xs text-subtle" title={x.email}>{x.email}</div>
                  </td>
                  <td className={`${tdCls} max-w-[220px] truncate text-muted`} title={`${x.title}${x.organization ? `, ${x.organization}` : ""}`}>{x.title}{x.organization ? `, ${x.organization}` : ""}</td>
                  <td className={`${tdCls} max-w-[200px] truncate text-muted`} title={x.domains.join(", ")}>{x.domains.join(", ")}</td>
                  <td className={tdCls}><StatusDot tone={tone(x.status)}>{x.status}</StatusDot> <span className="ml-2 font-mono text-xs text-subtle">{x.source}</span></td>
                  <td className={`${tdCls} text-right`}><Btn variant="ghost" size="sm" disabled={!selected || x.status !== "active"} loading={busyId === `i${x.id}`} onClick={() => void invite(x.id)}>Invite</Btn></td>
                </tr>
              ))}</tbody>
            </table>
          </TableWrap>
        )}
      </Section>

      <CallSlots />

      <Section title="Engagements">
        {data.engagements.length === 0 ? <TableWrap><Empty title="No engagements" body="Invites appear here once drafted." /></TableWrap> : (
          <ul className="divide-y divide-line rounded-[4px] border border-line-2">{data.engagements.map((e) => (
            <li key={e.id} className="space-y-2 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="t-h4">{expertName.get(e.expertId) ?? "Expert"}</span><span className="text-sm text-muted">on {requestDomain.get(e.requestId) ?? "request"}</span>
                  <StatusDot tone={tone(e.status)}>{e.status}</StatusDot>{e.draftStatus && <span className="font-mono text-xs text-subtle">email {e.draftStatus}</span>}
                  <span className="font-mono text-xs text-subtle">{dollars(e.honorariumCents)}</span>
                  {e.scheduledAt && <span className="font-mono text-xs text-subtle">call {when(e.scheduledAt)}</span>}
                </div>
                {e.status === "answered" && <Btn variant="ghost" size="sm" loading={busyId === `p${e.id}`} onClick={() => void markPaid(e.id)}>Mark paid</Btn>}
              </div>
              <EngagementNotes engagement={e} onSaved={() => void reload()} />
              {e.answers && <details className="text-sm"><summary className="cursor-pointer text-[13px] text-muted hover:text-fg">View answers</summary>
                <ol className="mt-2 space-y-2">{e.answers.map((a) => <li key={a.questionIndex}><span className="font-mono text-xs text-subtle">Q{a.questionIndex + 1}</span><p className="whitespace-pre-wrap">{a.answer}</p></li>)}</ol></details>}
            </li>
          ))}</ul>
        )}
      </Section>
    </div>
  );
}
