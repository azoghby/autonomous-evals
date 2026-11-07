"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, dollars, errMsg, microUsd, PACKAGE_LABEL, when } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import type { OperatorOverview } from "@/lib/client/types";
import { Btn, Chip, Empty, ErrorBox, Field, Glass, Input, Loading, PageTitle, StateChip, Textarea } from "./ui";

const KINDS = ["refund", "override", "fix", "approve_outreach", "other"] as const;

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-glass-border/60 py-2 last:border-0">
      <div><div className="text-sm">{label}</div>{note && <div className="text-xs text-cream/50">{note}</div>}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-3"><h2 className="text-lg font-semibold">{title}</h2>{children}</section>;
}

export function OperatorConsole() {
  const router = useRouter();
  const { data, error, loading, reload } = useFetch<OperatorOverview>("/api/operator/overview");
  useEffect(() => { if (error?.status === 401) router.replace("/signin?next=/operator"); }, [error, router]);

  if (loading) return <Loading label="Loading operator console" />;
  if (error?.status === 401) return <Loading label="Redirecting to sign in" />;
  if (error?.status === 403) return <Empty title="Operators only" body="Your account is not on the operator allowlist." />;
  if (error || !data) return <ErrorBox message={error?.message ?? "Unknown error"} onRetry={reload} />;

  const naive = data.knownCosts?.naiveMicroUsd ?? 0;
  const gw = data.knownCosts?.aiGatewayMicroUsd ?? 0;
  const unknown = data.unknownCosts?.length ? data.unknownCosts : ["Customer provider usage (their own API credits)", "Hosting (Vercel, Neon)"];
  const jobs = data.jobs ?? [];

  return (
    <div className="space-y-10">
      <PageTitle title="Operator console" sub="Revenue, known costs, and unknown costs are kept separate on purpose. Nothing here is profit." />

      <div className="grid gap-4 md:grid-cols-3">
        <Glass><h2 className="mb-2 text-sm font-semibold text-[#7fd1a8]">Revenue</h2>
          <Stat label="Live Stripe" value={dollars(data.revenue?.liveCents ?? 0)} note="Test-mode payments never count" />
        </Glass>
        <Glass><h2 className="mb-2 text-sm font-semibold text-[#ffc56b]">Known costs</h2>
          <Stat label="Naïve agents" value={microUsd(naive)} />
          <Stat label="AI Gateway" value={microUsd(gw)} />
          <Stat label="Total known" value={microUsd(naive + gw)} />
        </Glass>
        <Glass><h2 className="mb-2 text-sm font-semibold text-coral">Unknown costs</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-cream/80">{unknown.map((u) => <li key={u}>{u}: <span className="text-cream/60">unknown</span></li>)}</ul>
        </Glass>
      </div>

      <Section title="Jobs">
        {jobs.length === 0 ? <Empty title="No jobs yet" body="Jobs appear here as customers submit requests." /> : (
          <div className="overflow-x-auto rounded-[18px] border border-glass-border bg-glass backdrop-blur-xl">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs uppercase text-cream/50"><tr>
                {["Customer", "Package", "State", "Env", "Revenue", "Known cost"].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}
              </tr></thead>
              <tbody>{jobs.map((j) => (
                <tr key={j.id} className="border-t border-glass-border/60">
                  <td className="px-4 py-2.5"><Link className="underline decoration-cream/30 hover:text-coral" href={`/jobs/${j.id}`}>{j.customerEmail ?? j.id.slice(0, 8)}</Link></td>
                  <td className="px-4 py-2.5">{PACKAGE_LABEL[j.package] ?? j.package}</td>
                  <td className="px-4 py-2.5"><StateChip state={j.state} /></td>
                  <td className="px-4 py-2.5"><Chip tone={j.environment === "live" ? "ok" : "warn"}>{j.environment}</Chip></td>
                  <td className="px-4 py-2.5 tabular-nums">{j.environment === "live" ? dollars(j.revenueCents ?? 0) : <span className="text-cream/40">not counted</span>}</td>
                  <td className="px-4 py-2.5 tabular-nums">{microUsd(j.knownCostMicroUsd ?? 0)}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Payments">
        {(data.payments ?? []).length === 0 ? <p className="text-sm text-cream/60">No payments recorded.</p> : (
          <ul className="divide-y divide-glass-border/60 rounded-[18px] border border-glass-border bg-glass backdrop-blur-xl">
            {data.payments!.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span>{dollars(p.amountCents)} {p.kind && <span className="text-cream/50">· {p.kind}</span>}</span>
                <span className="flex items-center gap-3"><Chip tone={p.environment === "live" ? "ok" : "warn"}>{p.environment}</Chip><span className="text-xs text-cream/50">{when(p.createdAt)}</span></span>
              </li>))}
          </ul>
        )}
      </Section>

      <Section title="Agent decisions">
        {(data.decisions ?? []).length === 0 ? <p className="text-sm text-cream/60">No agent decisions yet.</p> : (
          <ul className="space-y-2">
            {data.decisions!.map((d) => (
              <li key={d.id} className="rounded-2xl border border-glass-border bg-glass px-4 py-2.5 text-sm backdrop-blur-xl">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span><Chip tone="info">{d.agent}</Chip> <span className="ml-2">{d.decision ?? d.status ?? "-"}</span></span>
                  <span className="text-xs text-cream/50">{d.usageMicroUsd != null ? `${microUsd(d.usageMicroUsd)} · ` : ""}{when(d.createdAt)}</span>
                </div>
              </li>))}
          </ul>
        )}
      </Section>

      <InterventionSection items={data.interventions ?? []} jobs={jobs.map((j) => j.id)} onAdded={reload} />
      <OutreachSection items={data.outreach ?? []} onChanged={reload} />
    </div>
  );
}

function InterventionSection({ items, jobs, onAdded }: { items: NonNullable<OperatorOverview["interventions"]>; jobs: string[]; onAdded: () => Promise<void> }) {
  const [kind, setKind] = useState<(typeof KINDS)[number]>("other");
  const [jobId, setJobId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) { setError("A note is required."); return; }
    setBusy(true); setError(null);
    try {
      await api("/api/operator/interventions", { method: "POST", json: { ...(jobId ? { jobId } : {}), kind, note } });
      setNote(""); await onAdded();
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }

  return (
    <Section title="Intervention log">
      {items.length === 0 ? <p className="text-sm text-cream/60">No founder interventions logged.</p> : (
        <ul className="space-y-2">{items.map((i) => (
          <li key={i.id} className="rounded-2xl border border-glass-border bg-glass px-4 py-2.5 text-sm backdrop-blur-xl">
            <div className="flex flex-wrap items-center gap-2"><Chip tone="warn">{i.kind}</Chip><span className="text-xs text-cream/50">{i.operatorEmail} · {when(i.createdAt)}{i.jobId ? ` · job ${i.jobId.slice(0, 8)}` : ""}</span></div>
            <p className="mt-1 whitespace-pre-wrap text-cream/85">{i.note}</p>
          </li>))}
        </ul>
      )}
      <Glass>
        <form onSubmit={add} className="space-y-3">
          <h3 className="text-sm font-semibold">Log an intervention</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind">
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="w-full rounded-full border border-glass-border bg-navy-deep/60 px-4 py-2.5 text-sm">
                {KINDS.map((k) => <option key={k}>{k}</option>)}
              </select>
            </Field>
            <Field label="Job ID (optional)"><Input list="job-ids" value={jobId} onChange={(e) => setJobId(e.target.value)} placeholder="uuid" />
              <datalist id="job-ids">{jobs.map((j) => <option key={j} value={j} />)}</datalist></Field>
          </div>
          <Field label="Note" error={error ?? undefined}><Textarea className="min-h-20" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <Btn type="submit" loading={busy}>Add to log</Btn>
        </form>
      </Glass>
    </Section>
  );
}

function OutreachSection({ items, onChanged }: { items: NonNullable<OperatorOverview["outreach"]>; onChanged: () => Promise<void> }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, verb: "approve" | "reject") {
    setBusyId(id + verb); setError(null);
    try { await api(`/api/operator/outreach/${id}/${verb}`, { method: "POST" }); await onChanged(); }
    catch (e) { setError(errMsg(e)); } finally { setBusyId(null); }
  }

  const pending = items.filter((o) => o.status === "pending");
  return (
    <Section title="Outreach approval queue">
      {error && <ErrorBox message={error} />}
      {pending.length === 0 ? <p className="text-sm text-cream/60">Nothing waiting for approval. Nothing is sent without it.</p> : (
        <ul className="space-y-3">{pending.map((o) => (
          <li key={o.id}><Glass>
            <div className="text-xs text-cream/50">To {o.toEmail}</div>
            <div className="font-semibold">{o.subject}</div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-cream/80">{o.body}</p>
            <div className="mt-4 flex gap-2">
              <Btn onClick={() => act(o.id, "approve")} loading={busyId === o.id + "approve"} disabled={busyId !== null}>Approve &amp; send</Btn>
              <Btn variant="danger" onClick={() => act(o.id, "reject")} loading={busyId === o.id + "reject"} disabled={busyId !== null}>Reject</Btn>
            </div>
          </Glass></li>))}
        </ul>
      )}
      {items.length > pending.length && <p className="text-xs text-cream/50">{items.length - pending.length} already decided or sent.</p>}
    </Section>
  );
}
