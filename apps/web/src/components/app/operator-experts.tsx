"use client";
import { useState } from "react";
import { api, dollars, errMsg, when } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import { Btn, Chip, Empty, ErrorBox, Field, Glass, Input, Loading, Textarea } from "./ui";

interface Request { id: string; domain: string; purpose: string; questions: string[]; maxBudgetCents: number; status: string; jobId: string | null; createdAt: string }
interface Expert { id: string; name: string; email: string; title: string; organization: string | null; domains: string[]; source: string; status: string; rateCents: number | null }
interface Engagement {
  id: string; requestId: string; expertId: string; mode: string; status: string; honorariumCents: number; paidAt: string | null;
  answeredAt: string | null; draftStatus: string | null; createdAt: string; answers: { questionIndex: number; answer: string }[] | null;
}
interface Overview {
  requests: Request[]; experts: Expert[]; engagements: Engagement[];
  counts: { requests: number; experts: number; engagements: number; responses: number; suppressions: number };
  honorariaOwedCents: number; honorariaPaidCents: number; coldContactsToday: number; coldContactLimit: number;
}

const tone = (s: string) => (s === "answered" ? "warn" : s === "paid" ? "ok" : s === "cancelled" || s === "opted_out" ? "muted" : "info") as "warn" | "ok" | "muted" | "info";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-3"><h2 className="text-lg font-semibold">{title}</h2>{children}</section>;
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
    <Glass>
      <form onSubmit={submit} className="space-y-4">
        <h3 className="font-semibold">New expert request</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Domain"><Input name="domain" required /></Field>
          <Field label="Honorarium budget (USD)" hint="$0 means no experts can be invited"><Input name="budget" type="number" min={0} step="1" defaultValue={25} /></Field>
        </div>
        <Field label="Purpose" hint="Shown to the expert. Never include customer data."><Input name="purpose" required /></Field>
        <Field label="Questions (one per line, max 8)"><Textarea name="questions" required rows={4} /></Field>
        <Field label="Job id (optional)"><Input name="jobId" placeholder="uuid" /></Field>
        {err && <p role="alert" className="text-sm text-coral">{err}</p>}
        <Btn type="submit" loading={busy}>Create request</Btn>
      </form>
    </Glass>
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
      <div className="grid gap-4 sm:grid-cols-4">
        <Glass><div className="text-xs text-cream/60">Honoraria owed</div><div className="text-2xl font-semibold tabular-nums">{dollars(data.honorariaOwedCents)}</div></Glass>
        <Glass><div className="text-xs text-cream/60">Honoraria paid</div><div className="text-2xl font-semibold tabular-nums">{dollars(data.honorariaPaidCents)}</div></Glass>
        <Glass><div className="text-xs text-cream/60">Responses</div><div className="text-2xl font-semibold tabular-nums">{data.counts.responses}</div></Glass>
        <Glass><div className="text-xs text-cream/60">Cold contacts today</div><div className="text-2xl font-semibold tabular-nums">{data.coldContactsToday}/{data.coldContactLimit}</div></Glass>
      </div>
      {notice && <p role={notice.ok ? "status" : "alert"} className={notice.ok ? "text-sm text-[#7fd1a8]" : "text-sm text-coral"}>{notice.text}</p>}

      <Section title="Requests">
        {data.requests.length === 0 ? <Empty title="No requests yet" body="Create one below, or wait for an agent to emit one." /> : (
          <ul className="space-y-3">{data.requests.map((r) => (
            <li key={r.id}><Glass className="space-y-2">
              <div className="flex flex-wrap items-center gap-2"><strong>{r.domain}</strong><Chip tone={tone(r.status)}>{r.status}</Chip>
                <span className="text-xs text-cream/60">budget {dollars(r.maxBudgetCents)} · {when(r.createdAt)}</span></div>
              <p className="text-sm text-cream/75">{r.purpose}</p>
              <ol className="list-decimal space-y-0.5 pl-5 text-sm text-cream/85">{r.questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
            </Glass></li>
          ))}</ul>
        )}
        <NewRequest onCreated={() => void reload()} />
      </Section>

      <Section title={`Experts (${data.experts.length})`}>
        {data.requests.length > 0 && (
          <label className="flex flex-wrap items-center gap-3 text-sm">Invite into
            <select value={selected} onChange={(e) => setRequestId(e.target.value)}
              className="rounded-full border border-glass-border bg-navy-deep/60 px-4 py-2 text-sm text-cream">
              {data.requests.map((r) => <option key={r.id} value={r.id}>{r.domain} ({r.status})</option>)}
            </select></label>
        )}
        {data.experts.length === 0 ? <Empty title="No experts yet" body="Share /experts so professionals can opt in." /> : (
          <ul className="space-y-2">{data.experts.map((x) => (
            <li key={x.id}><Glass className="flex flex-wrap items-center justify-between gap-3 !p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><strong>{x.name}</strong><Chip tone={tone(x.status)}>{x.status}</Chip><Chip tone="muted">{x.source}</Chip></div>
                <div className="text-sm text-cream/70">{x.title}{x.organization ? `, ${x.organization}` : ""} · {x.domains.join(", ")}</div>
                <div className="text-xs text-cream/50">{x.email}</div>
              </div>
              <Btn variant="ghost" disabled={!selected || x.status !== "active"} loading={busyId === `i${x.id}`} onClick={() => void invite(x.id)}>Invite</Btn>
            </Glass></li>
          ))}</ul>
        )}
      </Section>

      <Section title="Engagements">
        {data.engagements.length === 0 ? <Empty title="No engagements" body="Invites appear here once drafted." /> : (
          <ul className="space-y-2">{data.engagements.map((e) => (
            <li key={e.id}><Glass className="space-y-2 !p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{expertName.get(e.expertId) ?? "Expert"}</strong><span className="text-sm text-cream/60">on {requestDomain.get(e.requestId) ?? "request"}</span>
                  <Chip tone={tone(e.status)}>{e.status}</Chip>{e.draftStatus && <Chip tone="muted">email {e.draftStatus}</Chip>}
                  <span className="text-xs text-cream/60">{dollars(e.honorariumCents)}</span>
                </div>
                {e.status === "answered" && <Btn variant="ghost" loading={busyId === `p${e.id}`} onClick={() => void markPaid(e.id)}>Mark paid</Btn>}
              </div>
              {e.answers && <details className="text-sm"><summary className="cursor-pointer text-cream/70">View answers</summary>
                <ol className="mt-2 space-y-2">{e.answers.map((a) => <li key={a.questionIndex}><span className="text-xs text-cream/50">Q{a.questionIndex + 1}</span><p className="whitespace-pre-wrap">{a.answer}</p></li>)}</ol></details>}
            </Glass></li>
          ))}</ul>
        )}
      </Section>
    </div>
  );
}
