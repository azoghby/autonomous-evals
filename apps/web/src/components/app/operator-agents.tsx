"use client";
import { Fragment, useState } from "react";
import { api, errMsg, microUsd, when } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import type { OperatorCompanyView, OperatorAgentRow } from "@/server/company/queries";
import { MarketBriefView, SafeLink } from "@/components/company/MarketBriefView";
import { Banner, Btn, Chip, Empty, ErrorBox, Loading, Metric, MetricStrip, Mono, Section, TableWrap, Th, tableCls, tdCls, tdNumCls, trCls } from "./ui";

type Tone = "ok" | "warn" | "bad" | "info" | "muted";
const STATUS_TONE: Record<string, Tone> = { ok: "ok", running: "info", skipped: "muted", failed: "bad", budget: "warn" };
const statusChip = (s: string) => <Chip tone={STATUS_TONE[s] ?? "muted"}>{s}</Chip>;
const trunc = (s: string | null, n = 110) => (!s ? "" : s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/** Accessible switch (role="switch" on a button). */
function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "border-accent bg-accent" : "border-line-3 bg-bg-raised"}`}>
      <span aria-hidden className={`absolute left-0.5 top-0.5 size-4 rounded-full bg-white transition-transform duration-150 motion-reduce:transition-none ${checked ? "translate-x-5" : ""}`} />
    </button>
  );
}

function AgentRow({ a, onChanged }: { a: OperatorAgentRow; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<"toggle" | "run" | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const toggle = async (enabled: boolean) => {
    setBusy("toggle"); setMsg(null);
    try { await api("/api/operator/company/toggle", { method: "POST", json: { agentId: a.id, enabled } }); await onChanged(); }
    catch (e) { setMsg({ tone: "bad", text: errMsg(e) }); } finally { setBusy(null); }
  };
  const run = async () => {
    setBusy("run"); setMsg(null);
    try {
      const r = await api<unknown>("/api/operator/company/run", { method: "POST", json: { agentId: a.id } });
      setMsg({ tone: "ok", text: JSON.stringify(r) });
      await onChanged();
    } catch (e) { setMsg({ tone: "bad", text: errMsg(e) }); } finally { setBusy(null); }
  };

  return (
    <>
      <tr className={trCls}>
        <td className={tdCls}>
          <div className="flex items-center gap-3">
            <Switch checked={a.enabled} onChange={toggle} disabled={busy !== null} label={`${a.name} enabled`} />
            <span><span className="block text-fg">{a.name}</span><span className="block text-xs text-subtle">{a.toggle === null ? `default ${a.enabled ? "on" : "off"}` : "set by operator"}</span></span>
          </div>
        </td>
        <td className={`${tdCls} text-muted`}>{a.model}</td>
        <td className={`${tdNumCls} text-muted`}>{microUsd(a.runBudgetMicroUsd)}</td>
        <td className={tdNumCls}>{microUsd(a.spentTodayMicroUsd)}</td>
        <td className={tdCls}>{a.lastRun ? <span className="flex items-center gap-3">{statusChip(a.lastRun.status)}<span className="text-xs text-subtle">{when(a.lastRun.at)}</span></span> : <span className="text-subtle">never</span>}</td>
        <td className={`${tdCls} text-right`}><Btn size="sm" variant="ghost" loading={busy === "run"} disabled={busy !== null} onClick={run}>Run now</Btn></td>
      </tr>
      {msg && <tr><td colSpan={6} className="px-4 pb-3"><Banner tone={msg.tone}><span className="break-all font-mono text-xs">{msg.text}</span></Banner></td></tr>}
    </>
  );
}

function ActivityTable({ rows }: { rows: OperatorCompanyView["activity"] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (rows.length === 0) return <TableWrap><Empty title="No activity yet" body="Runs appear here as agents work." /></TableWrap>;
  return (
    <TableWrap>
      <table className={`${tableCls} min-w-[860px]`}>
        <thead><tr><Th>Time</Th><Th>Agent</Th><Th>Trigger</Th><Th>Status</Th><Th num>Cost</Th><Th>Summary</Th><Th><span className="sr-only">Detail</span></Th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.id}>
              <tr className={trCls}>
                <td className={`${tdCls} text-subtle`}>{when(r.startedAt)}</td>
                <td className={tdCls}>{r.agentId}{r.dryRun && <span className="ml-2 text-xs text-warn">dry</span>}</td>
                <td className={`${tdCls} text-muted`}>{r.trigger}</td>
                <td className={tdCls}>{statusChip(r.status)}</td>
                <td className={`${tdNumCls} text-muted`}>{microUsd(r.costMicroUsd)}</td>
                <td className={`${tdCls} max-w-[360px] truncate`} title={r.summary ?? r.error ?? ""}>{trunc(r.error ?? r.summary)}</td>
                <td className={tdCls}><button type="button" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)} className="text-sm text-fg-2 underline decoration-line-3 underline-offset-4 hover:text-accent-text focus-visible:outline-2 focus-visible:outline-accent">{open === r.id ? "Hide" : "Detail"}</button></td>
              </tr>
              {open === r.id && <tr><td colSpan={7} className="px-4 pb-4"><Mono>{JSON.stringify({ counts: r.counts, publicSummary: r.publicSummary, error: r.error, detail: r.detail }, null, 2)}</Mono></td></tr>}
            </Fragment>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function LeadsTable({ leads }: { leads: OperatorCompanyView["leads"] }) {
  if (leads.length === 0) return <TableWrap><Empty title="No leads yet" body="The Prospecting agent writes leads here." /></TableWrap>;
  return (
    <TableWrap>
      <table className={`${tableCls} min-w-[900px]`}>
        <thead><tr><Th>Company</Th><Th>Domain</Th><Th>Segment</Th><Th num>Fit</Th><Th>Plan</Th><Th>Contact</Th><Th>Status</Th><Th>Evidence</Th></tr></thead>
        <tbody>
          {leads.map((l) => (
            <tr key={l.id} className={trCls}>
              <td className={`${tdCls} max-w-[200px] truncate text-fg`} title={l.agentDescription}>{l.company}</td>
              <td className={`${tdCls} text-muted`}>{l.domain}</td>
              <td className={`${tdCls} text-muted`}>{l.segment}</td>
              <td className={tdNumCls} title={l.fitReason}>{l.fitScore}</td>
              <td className={tdCls}>{l.recommendedPlan}</td>
              <td className={tdCls}>{l.hasContactEmail ? <Chip tone="ok">email{l.contactRole ? ` · ${trunc(l.contactRole, 24)}` : ""}</Chip> : <Chip tone="muted">none</Chip>}</td>
              <td className={tdCls}>{l.status}</td>
              <td className={tdCls}>{l.evidence.slice(0, 3).map((e, i) => <span key={e.url} className="mr-2"><SafeLink url={e.url} label={`[${i + 1}]`} /></span>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function PlansAndTasks({ view }: { view: OperatorCompanyView }) {
  if (view.plans.length === 0) return <p className="text-sm text-subtle">No plans yet. The Planner writes one each morning.</p>;
  return (
    <div className="space-y-6">
      {view.plans.map((p) => (
        <div key={p.planDate} className="rounded-[4px] border border-line-2 p-4">
          <p className="font-mono text-[11px] uppercase text-subtle">{p.planDate}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-fg-2">{p.summary}</p>
          <ul className="mt-4 space-y-2">
            {view.tasks.filter((t) => t.planDate === p.planDate).map((t) => (
              <li key={t.id} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                <span className="font-mono text-xs text-subtle">P{t.priority}</span>
                <span className="text-muted">{t.assignee}</span>
                <span className="text-fg">{t.title}</span>
                {statusChip(t.status)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Operator-only: toggles, spend, activity, briefs, leads and the planner's tasks (GET /api/operator/company). */
export function OperatorAgents() {
  const { data, error, loading, reload } = useFetch<OperatorCompanyView>("/api/operator/company");
  if (loading) return <Loading label="Loading agents" />;
  if (error || !data) return <ErrorBox message={error?.message ?? "Unknown error"} onRetry={reload} />;
  const { spend } = data;
  const pct = spend.dailyBudgetMicroUsd > 0 ? Math.min(100, Math.round((spend.todayMicroUsd / spend.dailyBudgetMicroUsd) * 100)) : 0;
  const latest = data.briefs[0];

  return (
    <div className="space-y-14">
      <div>
        <MetricStrip>
          <Metric label="Spent today" value={microUsd(spend.todayMicroUsd)} note={`of ${microUsd(spend.dailyBudgetMicroUsd)} daily cap`} />
          <Metric label="Agents on" value={`${data.agents.filter((a) => a.enabled).length}/${data.agents.length}`} />
          <Metric label="Leads" value={String(data.leads.length)} note="top 100 by fit" />
          <Metric label="Runs shown" value={String(data.activity.length)} note="latest 100" />
        </MetricStrip>
        <div role="progressbar" aria-label="Daily spend" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="mt-3 h-1 overflow-hidden rounded-full bg-line-2">
          <div className={`h-full ${pct >= 90 ? "bg-danger" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <Section title="Company agents">
        <TableWrap>
          <table className={`${tableCls} min-w-[820px]`}>
            <thead><tr><Th>Agent</Th><Th>Model</Th><Th num>Run budget</Th><Th num>Spent today</Th><Th>Last run</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>{data.agents.map((a) => <AgentRow key={a.id} a={a} onChanged={reload} />)}</tbody>
          </table>
        </TableWrap>
      </Section>

      <Section title="Activity"><ActivityTable rows={data.activity} /></Section>
      <Section title="Latest market brief">
        {latest ? <MarketBriefView brief={latest.brief} date={latest.briefDate} /> : <p className="text-sm text-subtle">No briefs yet.</p>}
      </Section>
      <Section title="Prospect leads"><LeadsTable leads={data.leads} /></Section>
      <Section title="Plan and tasks"><PlansAndTasks view={data} /></Section>
    </div>
  );
}
