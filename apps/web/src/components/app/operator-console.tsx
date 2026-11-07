"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, dollars, errMsg, microUsd, PACKAGE_LABEL, when } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import { useLiveOperator } from "@/lib/client/use-live-operator";
import type { OperatorOverview } from "@/lib/client/types";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Btn, Chip, Empty, ErrorBox, Field, Input, LiveChip, Loading, PageTitle, StateChip, Textarea } from "./ui";
import { EASE, SPRING, Stagger, StaggerItem } from "./motion";
import { OperatorExperts } from "./operator-experts";
import { OperatorInfra } from "./operator-infra";

const UNKNOWN_COSTS = ["Customer provider usage (their own API credits)", "Hosting (Vercel, Neon)"];
const KINDS = ["refund", "override", "fix", "approve_outreach", "other"] as const;

const TABS = ["Overview", "Experts", "Infra"] as const;
type Tab = (typeof TABS)[number];

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-4 border-t border-line pt-6"><h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-subtle">{title}</h2>{children}</section>;
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <div className="text-xs text-subtle">{label}</div>
      <div className="mt-1 font-mono text-2xl font-medium tabular-nums tracking-tight">{value}</div>
      {note && <div className="mt-0.5 text-xs text-subtle">{note}</div>}
    </div>
  );
}

const th = "px-0 py-2 pr-6 text-left text-xs font-normal text-subtle";
const td = "py-3 pr-6";

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <LayoutGroup id="op-tabs">
      <div role="tablist" aria-label="Operator sections" className="mb-10 flex gap-8 border-b border-line">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => onChange(t)}
            className={`relative pb-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent ${tab === t ? "text-fg" : "text-subtle hover:text-muted"}`}>
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
      <PageTitle title="Operator" sub="Revenue, known costs, and unknown costs are kept separate on purpose. Nothing here is profit." right={liveOp.mode === "live" ? <LiveChip /> : undefined} />
      <Tabs tab={tab} onChange={setTab} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.28, ease: EASE }}>
          {tab === "Overview" && <Overview data={data} reload={reload} />}
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

  return (
    <Stagger className="space-y-12">
      <StaggerItem>
        <div className="grid grid-cols-2 gap-x-8 gap-y-6 md:grid-cols-4">
          <Metric label="Live revenue" value={dollars(data.liveRevenueCents ?? 0)} note="Test-mode payments never count" />
          <Metric label="Naive agents" value={microUsd(naive)} />
          <Metric label="AI Gateway" value={microUsd(gw)} />
          <Metric label="Total known cost" value={microUsd(data.knownCostMicroUsd ?? naive + gw)} />
        </div>
        <p className="mt-6 text-xs text-subtle">Unknown, not included: {UNKNOWN_COSTS.join("; ")}.</p>
      </StaggerItem>

      <StaggerItem><Section title="Jobs">
        {jobs.length === 0 ? <Empty title="No jobs yet" body="Jobs appear here as customers submit requests." /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr>{["Customer", "Package", "State", "Env", "Revenue", "Known cost"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
              <tbody>{jobs.map((j) => (
                <tr key={j.id} className="border-t border-line transition-colors hover:bg-bg-raised">
                  <td className={td}><Link className="text-fg/90 underline decoration-line-strong underline-offset-4 hover:decoration-accent-bright" href={`/jobs/${j.id}`}>{j.customerEmail ?? j.id.slice(0, 8)}</Link></td>
                  <td className={`${td} text-muted`}>{PACKAGE_LABEL[j.package] ?? j.package}</td>
                  <td className={td}><StateChip state={j.state} /></td>
                  <td className={td}><Chip tone={j.environment === "live" ? "ok" : "warn"}>{j.environment}</Chip></td>
                  <td className={`${td} tabular-nums`}>{j.environment === "live" ? dollars(revenueByJob.get(j.id) ?? 0) : <span className="text-subtle">not counted</span>}</td>
                  <td className={`${td} tabular-nums text-muted`}>{microUsd(j.knownCostMicroUsd ?? 0)}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Section></StaggerItem>

      <StaggerItem><Section title="Payments">
        {(data.payments ?? []).length === 0 ? <p className="text-sm text-subtle">No payments recorded.</p> : (
          <table className="w-full text-sm"><tbody>
            {data.payments!.map((p) => (
              <tr key={p.id} className="border-t border-line">
                <td className={`${td} tabular-nums`}>{dollars(p.amountCents)}</td>
                <td className={`${td} text-subtle`}>{p.kind ?? ""}</td>
                <td className={td}><Chip tone={p.environment === "live" ? "ok" : "warn"}>{p.environment}</Chip></td>
                <td className="py-3 text-right text-xs text-subtle">{when(p.createdAt)}</td>
              </tr>))}
          </tbody></table>
        )}
      </Section></StaggerItem>

      <StaggerItem><Section title="Agent decisions">
        {(data.agentSessions ?? []).length === 0 ? <p className="text-sm text-subtle">No agent decisions yet.</p> : (
          <table className="w-full text-sm"><tbody>
            {data.agentSessions.map((d) => (
              <tr key={d.id} className="border-t border-line">
                <td className={`${td} text-muted`}>{d.agent}</td>
                <td className={td}>{d.decision ?? d.status ?? "-"}</td>
                <td className="py-3 text-right text-xs text-subtle">{d.usageMicroUsd != null ? `${microUsd(d.usageMicroUsd)} · ` : ""}{when(d.createdAt)}</td>
              </tr>))}
          </tbody></table>
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
        <ul>{items.map((i) => (
          <li key={i.id} className="border-t border-line py-3 text-sm">
            <div className="flex flex-wrap items-center gap-4"><Chip tone="warn">{i.kind}</Chip><span className="text-xs text-subtle">{i.operatorEmail} · {when(i.createdAt)}{i.jobId ? ` · job ${i.jobId.slice(0, 8)}` : ""}</span></div>
            <p className="mt-1 whitespace-pre-wrap text-fg/90">{i.note}</p>
          </li>))}
        </ul>
      )}
      <div className="pt-4">
        <form onSubmit={add} className="space-y-4">
          <h3 className="text-sm font-medium">Log an intervention</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind">
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="w-full rounded-md bg-bg-raised px-4 py-2.5 text-sm text-fg outline-none ring-1 ring-inset ring-line focus:ring-accent">
                {KINDS.map((k) => <option key={k}>{k}</option>)}
              </select>
            </Field>
            <Field label="Job ID (optional)"><Input list="job-ids" value={jobId} onChange={(e) => setJobId(e.target.value)} placeholder="uuid" />
              <datalist id="job-ids">{jobs.map((j) => <option key={j} value={j} />)}</datalist></Field>
          </div>
          <Field label="Note" error={error ?? undefined}><Textarea className="min-h-20" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <Btn type="submit" variant="ghost" loading={busy}>Add to log</Btn>
        </form>
      </div>
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
      {pending.length === 0 ? <p className="text-sm text-subtle">Nothing waiting for approval. Nothing is sent without it.</p> : (
        <ul>{pending.map((o) => (
          <li key={o.id} className="border-t border-line py-5">
            <div className="text-xs text-subtle">To {o.toEmail}</div>
            <div className="font-semibold">{o.subject}</div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-fg/90">{o.body}</p>
            <div className="mt-4 flex gap-2">
              <Btn onClick={() => act(o.id, "approve")} loading={busyId === o.id + "approve"} disabled={busyId !== null}>Approve &amp; send</Btn>
              <Btn variant="danger" onClick={() => act(o.id, "reject")} loading={busyId === o.id + "reject"} disabled={busyId !== null}>Reject</Btn>
            </div>
          </li>))}
        </ul>
      )}
      {items.length > pending.length && <p className="text-xs text-subtle">{items.length - pending.length} already decided or sent.</p>}
    </Section>
  );
}
