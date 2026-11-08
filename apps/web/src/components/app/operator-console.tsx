"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, dollars, errMsg, microUsd, PACKAGE_LABEL, when } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import { useLiveOperator } from "@/lib/client/use-live-operator";
import type { OperatorOverview } from "@/lib/client/types";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Chip as UiChip, Eyebrow, Frame } from "@/components/ui";
import { Btn, MetricStrip, Metric, Section, Empty, ErrorBox, Field, Input, LiveChip, Loading, StateChip, TableWrap, Textarea, Th, tableCls, tdCls, tdNumCls, trCls } from "./ui";
import { EASE, SPRING, Stagger, StaggerItem } from "./motion";
import { OperatorExperts } from "./operator-experts";
import { OperatorInfra } from "./operator-infra";
import { OperatorLeads } from "./operator-leads";

const UNKNOWN_COSTS = ["Customer provider usage (their own API credits)", "Hosting (Vercel, Neon)"];
const KINDS = ["refund", "override", "fix", "approve_outreach", "other"] as const;

const TABS = ["Overview", "Experts", "Infra"] as const;
type Tab = (typeof TABS)[number];

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <LayoutGroup id="op-tabs">
      <div role="tablist" aria-label="Operator sections" className="mb-10 flex gap-8 border-b border-line-2">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => onChange(t)}
            className={`relative h-11 text-[14px] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${tab === t ? "text-fg" : "text-subtle hover:text-fg-2"}`}>
            {t}
            {tab === t && <motion.span layoutId="op-tab-underline" transition={SPRING} className="absolute inset-x-0 -bottom-px h-px bg-accent" />}
          </button>
        ))}
      </div>
    </LayoutGroup>
  );
}

export function OperatorConsole() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("Overview");
  const { data, error, loading, reload } = useFetch<OperatorOverview>("/api/operator/overview");
  useEffect(() => { if (error?.status === 401) router.replace("/signin?next=/operator"); }, [error, router]);
  // Neon Realtime: reload the overview when live rows change; polls every 5s if realtime is unavailable.
  const liveOp = useLiveOperator(reload);
  useEffect(() => { if (liveOp.version > 0) void reload(); }, [liveOp.version, reload]);

  if (loading) return <Loading label="Loading operator console" />;
  if (error?.status === 401) return <Loading label="Redirecting to sign in" />;
  if (error?.status === 403) return <Empty title="Operators only" body="Your account is not on the operator allowlist." />;
  if (error || !data) return <ErrorBox message={error?.message ?? "Unknown error"} onRetry={reload} />;

  return (
    <div>
      <header className="mb-10">
        <Eyebrow className="mb-4">Operator</Eyebrow>
        <h1 className="t-h1">Operator console</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-muted">Revenue, known costs, and unknown costs are kept separate on purpose. Nothing here is profit.</p>
        {liveOp.mode === "live" && <div className="mt-4 flex items-center gap-4"><LiveChip /></div>}
      </header>
      <Tabs tab={tab} onChange={setTab} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.24, ease: EASE }}>
          {tab === "Overview" && <><Overview data={data} reload={reload} /><div className="mt-12"><OperatorLeads /></div></>}
          {tab === "Experts" && <OperatorExperts />}
          {tab === "Infra" && <OperatorInfra />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function Overview({ data, reload }: { data: OperatorOverview; reload: () => Promise<void> }) {
  const naive = data.knownCostBySourceMicroUsd?.naive ?? 0;
  const gw = data.knownCostBySourceMicroUsd?.ai_gateway ?? 0;
  const jobs = data.jobs ?? [];
  // Revenue per job counts live-mode payments on non-mock jobs only, matching the server's headline total.
  const revenueByJob = new Map<string, number>();
  for (const p of data.payments ?? []) {
    if (p.environment !== "live") continue;
    revenueByJob.set(p.jobId, (revenueByJob.get(p.jobId) ?? 0) + p.amountCents);
  }
  const envChip = (env: string) => <UiChip tone={env === "live" ? "ok" : "warn"}>{env}</UiChip>;

  return (
    <Stagger className="space-y-14">
      <StaggerItem>
        <MetricStrip>
          <Metric label="Live revenue" value={dollars(data.liveRevenueCents ?? 0)} note="Test-mode payments never count" />
          <Metric label="Naive agents" value={microUsd(naive)} note="Known cost" />
          <Metric label="AI Gateway" value={microUsd(gw)} note="Known cost" />
          <Metric label="Total known cost" value={microUsd(data.knownCostMicroUsd ?? naive + gw)} note="Sum of known sources" />
        </MetricStrip>
        <p className="mt-3 text-xs text-subtle">Unknown, not included: {UNKNOWN_COSTS.join("; ")}.</p>
      </StaggerItem>

      <StaggerItem><Section title="Jobs">
        {jobs.length === 0 ? <TableWrap><Empty title="No jobs yet" body="Jobs appear here as customers submit requests." /></TableWrap> : (
          <TableWrap>
            <table className={`${tableCls} min-w-[760px]`}>
              <thead><tr><Th>Customer</Th><Th>Package</Th><Th>State</Th><Th>Env</Th><Th num>Revenue</Th><Th num>Known cost</Th></tr></thead>
              <tbody>{jobs.map((j) => (
                <tr key={j.id} className={trCls}>
                  <td className={`${tdCls} max-w-[260px]`}><Link className="block truncate text-fg hover:text-accent-text" title={j.customerEmail ?? j.id} href={`/jobs/${j.id}`}>{j.customerEmail ?? j.id.slice(0, 8)}</Link></td>
                  <td className={`${tdCls} text-muted`}>{PACKAGE_LABEL[j.package] ?? j.package}</td>
                  <td className={tdCls}><StateChip state={j.state} /></td>
                  <td className={tdCls}>{envChip(j.environment)}</td>
                  <td className={tdNumCls}>{j.environment === "live" ? dollars(revenueByJob.get(j.id) ?? 0) : <span className="text-subtle" title="Test-mode: not counted">not counted</span>}</td>
                  <td className={`${tdNumCls} text-muted`}>{microUsd(j.knownCostMicroUsd ?? 0)}</td>
                </tr>))}</tbody>
            </table>
          </TableWrap>
        )}
      </Section></StaggerItem>

      <StaggerItem><Section title="Payments">
        {(data.payments ?? []).length === 0 ? <p className="text-sm text-subtle">No payments recorded.</p> : (
          <TableWrap>
            <table className={`${tableCls} min-w-[520px]`}>
              <thead><tr><Th num>Amount</Th><Th>Kind</Th><Th>Env</Th><Th num>When</Th></tr></thead>
              <tbody>{data.payments!.map((p) => (
                <tr key={p.id} className={trCls}>
                  <td className={tdNumCls}>{dollars(p.amountCents)}</td>
                  <td className={`${tdCls} text-muted`}>{p.kind ?? ""}</td>
                  <td className={tdCls}>{envChip(p.environment)}</td>
                  <td className={`${tdNumCls} whitespace-nowrap text-subtle`}>{when(p.createdAt)}</td>
                </tr>))}</tbody>
            </table>
          </TableWrap>
        )}
      </Section></StaggerItem>

      <StaggerItem><Section title="Agent decisions">
        {(data.agentSessions ?? []).length === 0 ? <p className="text-sm text-subtle">No agent decisions yet.</p> : (
          <TableWrap>
            <table className={`${tableCls} min-w-[560px]`}>
              <thead><tr><Th>Agent</Th><Th>Decision</Th><Th num>Usage</Th><Th num>When</Th></tr></thead>
              <tbody>{data.agentSessions.map((d) => (
                <tr key={d.id} className={trCls}>
                  <td className={`${tdCls} text-muted`}>{d.agent}</td>
                  <td className={tdCls}>{d.decision ?? d.status ?? "-"}</td>
                  <td className={`${tdNumCls} text-muted`}>{d.usageMicroUsd != null ? microUsd(d.usageMicroUsd) : ""}</td>
                  <td className={`${tdNumCls} whitespace-nowrap text-subtle`}>{when(d.createdAt)}</td>
                </tr>))}</tbody>
            </table>
          </TableWrap>
        )}
      </Section></StaggerItem>

      <StaggerItem><InterventionSection items={data.interventions ?? []} jobs={jobs.map((j) => j.id)} onAdded={reload} /></StaggerItem>
      <StaggerItem><OutreachSection items={data.outreachDrafts ?? []} onChanged={reload} /></StaggerItem>
    </Stagger>
  );
}

function InterventionSection({ items, jobs, onAdded }: { items: OperatorOverview["interventions"]; jobs: string[]; onAdded: () => Promise<void> }) {
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
      {items.length === 0 ? <p className="text-sm text-subtle">No founder interventions logged.</p> : (
        <ul className="ml-1 mb-2 border-l border-line-2">{items.map((i) => (
          <li key={i.id} className="relative pb-6 pl-6 last:pb-0">
            <span aria-hidden className="absolute -left-[3px] top-[7px] size-[5px] rounded-full bg-line-3" />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1"><UiChip tone="warn">{i.kind}</UiChip><span className="font-mono text-xs text-subtle">{i.operatorEmail} · {when(i.createdAt)}{i.jobId ? ` · job ${i.jobId.slice(0, 8)}` : ""}</span></div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-fg-2">{i.note}</p>
          </li>))}
        </ul>
      )}
      <Frame className="p-5 sm:p-6">
        <form onSubmit={add} className="space-y-4">
          <h3 className="t-h4">Log an intervention</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Kind">
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="select">
                {KINDS.map((k) => <option key={k}>{k}</option>)}
              </select>
            </Field>
            <Field label="Job ID (optional)"><Input list="job-ids" value={jobId} onChange={(e) => setJobId(e.target.value)} placeholder="uuid" />
              <datalist id="job-ids">{jobs.map((j) => <option key={j} value={j} />)}</datalist></Field>
          </div>
          <Field label="Note" error={error ?? undefined}><Textarea className="min-h-24" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <Btn type="submit" variant="ghost" loading={busy}>Add to log</Btn>
        </form>
      </Frame>
    </Section>
  );
}

function OutreachSection({ items, onChanged }: { items: OperatorOverview["outreachDrafts"]; onChanged: () => Promise<void> }) {
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
      <Frame>
        {pending.length === 0 ? <Empty title="Queue is empty" body="Nothing waiting for approval. Nothing is sent without it." /> : (
          <ul className="divide-y divide-line">{pending.map((o) => (
            <li key={o.id} className="p-5 sm:p-6">
              <div className="font-mono text-xs text-subtle">To {o.toEmail}</div>
              <div className="t-h4 mt-1">{o.subject}</div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-fg-2">{o.body}</p>
              <div className="mt-4 flex gap-2">
                <Btn onClick={() => act(o.id, "approve")} loading={busyId === o.id + "approve"} disabled={busyId !== null}>Approve &amp; send</Btn>
                <Btn variant="danger" onClick={() => act(o.id, "reject")} loading={busyId === o.id + "reject"} disabled={busyId !== null}>Reject</Btn>
              </div>
            </li>))}
          </ul>
        )}
      </Frame>
      {items.length > pending.length && <p className="text-xs text-subtle">{items.length - pending.length} already decided or sent.</p>}
    </Section>
  );
}
