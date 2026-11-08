import type { Metadata } from "next";
import { PageShell } from "@/components/ui";
import { getCurrentCustomer } from "@/server/session";
import { getPublicStatus, getStatusSummary, type CountRow, type CronInfo, type StatusSummary } from "@/server/status";
import type { OverallStatus, Probe, PublicStatus } from "@/server/status-logic";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Status · Standard Evals", description: "Live health of Standard Evals." };

const LEVEL_TONE = { operational: "ok", degraded: "warn", down: "danger" } as const;
const PROBE_TONE = { ok: "ok", degraded: "warn", down: "danger" } as const;

function barTone(key: string): string {
  if (["delivered", "complete"].includes(key)) return "ok";
  if (["failed", "cancelled"].includes(key)) return "danger";
  if (["paused_budget", "payment_review", "needs_clarification"].includes(key)) return "warn";
  if (["planning", "running", "investigating", "queued"].includes(key)) return "accent";
  return "muted";
}

function CountBar({ rows, label }: { rows: CountRow[]; label: string }) {
  const total = rows.reduce((a, r) => a + r.count, 0);
  if (total === 0) return <p className="t-data text-subtle">No records.</p>;
  return (
    <div>
      <div className="st-bar" role="img" aria-label={`${label}: ${rows.map((r) => `${r.count} ${r.key}`).join(", ")}`}>
        {rows.map((r) => (
          <span key={r.key} className="st-seg" data-tone={barTone(r.key)} style={{ flexGrow: r.count }} title={`${r.key}: ${r.count}`} />
        ))}
      </div>
      <ul className="st-legend">
        {rows.map((r) => (
          <li key={r.key} className="t-data">
            <span aria-hidden className="st-swatch" data-tone={barTone(r.key)} />
            <span className="text-fg-2">{r.key.replaceAll("_", " ")}</span>
            <span className="st-num">{r.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProbeRow({ p, detail }: { p: Probe; detail?: string }) {
  const note = p.errorClass ? `Probe failed: ${p.errorClass}` : p.notes[0] ?? detail ?? "";
  return (
    <li className="st-row" data-tone={PROBE_TONE[p.level]}>
      <span aria-hidden className="st-dot" />
      <div className="st-row-main">
        <p className="st-row-name">{p.label}</p>
        {note && <p className="t-data text-subtle">{note}</p>}
      </div>
      <span className="st-state t-eyebrow">{p.level === "ok" ? "OK" : p.level}</span>
      <span className="st-num t-data">{p.latencyMs != null ? `${p.latencyMs} ms` : "n/a"}</span>
    </li>
  );
}

function Section({ id, title, children, aside }: { id: string; title: string; children: React.ReactNode; aside?: string }) {
  return (
    <section aria-labelledby={id} className="st-section">
      <header className="st-section-head">
        <h2 id={id} className="t-eyebrow text-fg-2">{title}</h2>
        {aside && <span className="t-data text-subtle">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

function CronRow({ c }: { c: CronInfo }) {
  return (
    <li className="st-cron" data-state={c.state}>
      <div className="st-cron-main">
        <p className="t-data st-cron-path">{c.path}</p>
        <p className="t-data text-subtle">{c.cadence} · <code>{c.schedule}</code></p>
      </div>
      <div className="st-cron-act">
        <p className="t-data" data-dim={c.state === "unmapped" || c.state === "none"}>
          {c.lastActivityAt ? <time dateTime={c.lastActivityAt}>{c.lastActivityAge}</time> : c.lastActivityAge}
        </p>
        <p className="t-data text-subtle">{c.source ? `from ${c.source}` : "no table mapped"}</p>
      </div>
    </li>
  );
}

function Body({ s }: { s: StatusSummary }) {
  const get = (id: string) => s.probes.find((p) => p.id === id);
  const m = s.database?.migrations;
  const rows: { p: Probe | undefined; detail?: string }[] = [
    { p: get("database"), detail: "select 1 round trip" },
    { p: get("migrations"), detail: m && !m.error ? `${m.pending === 0 ? "Up to date" : `${m.pending} pending`} · ${m.expected} in this build${m.latestAppliedAt ? ` · latest ${m.latestAppliedAt.slice(0, 10)}` : ""}` : undefined },
    { p: get("jobs"), detail: s.jobs ? `${s.jobs.total} jobs · ${s.jobs.staleRunning} stale` : undefined },
    { p: get("sandbox"), detail: s.sandbox ? `${s.sandbox.total} runs in 24h · ${s.sandbox.staleRunning} stale` : undefined },
    { p: get("crons"), detail: s.crons ? `${s.crons.length} crons configured` : undefined },
  ];
  return (
    <>
      <Section id="st-components" title="Components" aside="latency = probe round trip">
        <ul className="st-list">{rows.map((r) => r.p && <ProbeRow key={r.p.id} p={r.p} detail={r.detail} />)}</ul>
      </Section>
      <div className="st-grid">
        <Section id="st-jobs" title="Jobs by status" aside={s.jobs ? `${s.jobs.total} total` : undefined}>
          {s.jobs ? <CountBar rows={s.jobs.byState} label="Jobs by status" /> : <p className="t-data text-danger">Unavailable.</p>}
        </Section>
        <Section id="st-sandbox" title="Sandbox runs, last 24h" aside={s.sandbox ? `${s.sandbox.total} runs` : undefined}>
          {s.sandbox ? <CountBar rows={s.sandbox.byStatus} label="Sandbox runs by status" /> : <p className="t-data text-danger">Unavailable.</p>}
        </Section>
      </div>
      <Section id="st-crons" title="Scheduled jobs" aside="last recorded activity, not last run">
        {s.crons ? <ul className="st-list">{s.crons.map((c) => <CronRow key={c.path} c={c} />)}</ul> : <p className="t-data text-danger">Unavailable.</p>}
      </Section>
      <Section id="st-app" title="Deployment">
        <dl className="st-kv">
          {([["Environment", s.app.environment], ["Commit", s.app.commit], ["Region", s.app.region], ["Node env", s.app.nodeEnv], ["Server time", s.app.serverTime]] as const).map(([k, v]) => (
            <div key={k}><dt className="t-eyebrow text-subtle">{k}</dt><dd className="t-data">{v}</dd></div>
          ))}
        </dl>
      </Section>
    </>
  );
}

const PUBLIC_STATE = { ok: "Operational", degraded: "Degraded", down: "Outage" } as const;

function Hero({ overall, generatedAt, summary }: { overall: Pick<OverallStatus, "level" | "label">; generatedAt: string; summary: string }) {
  return (
    <header className="st-hero" data-tone={LEVEL_TONE[overall.level]}>
      <p className="t-eyebrow text-subtle">System status</p>
      <h1 className="st-headline t-h1" role="status">
        <span aria-hidden className="st-pulse" />
        <span data-testid="status-headline">{overall.label}</span>
      </h1>
      <p className="t-data text-subtle">
        {summary} · Checked <time dateTime={generatedAt}>{generatedAt.replace("T", " ").slice(0, 19)} UTC</time>.
      </p>
    </header>
  );
}

/** Anonymous view: one level per component, nothing else. */
function PublicBody({ s }: { s: PublicStatus }) {
  return (
    <Section id="st-components" title="Components">
      <ul className="st-list">
        {s.components.map((c) => (
          <li key={c.id} className="st-row" data-public="" data-tone={PROBE_TONE[c.level]}>
            <span aria-hidden className="st-dot" />
            <p className="st-row-name">{c.label}</p>
            <span className="st-state t-eyebrow">{PUBLIC_STATE[c.level]}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

async function isOperatorViewer(): Promise<boolean> {
  try {
    return (await getCurrentCustomer())?.isOperator === true;
  } catch {
    return false;
  }
}

export default async function StatusPage() {
  if (!(await isOperatorViewer())) {
    const p = await getPublicStatus();
    const summary = p.overall.level === "operational" ? "Everything is running normally" : "We are looking into it";
    return (
      <PageShell>
        <Hero overall={p.overall} generatedAt={p.generatedAt} summary={summary} />
        <PublicBody s={p} />
      </PageShell>
    );
  }
  const s = await getStatusSummary();
  const summary = s.overall.level === "operational" ? "All probes passed" : s.overall.reasons.join(" · ");
  return (
    <PageShell>
      <Hero overall={s.overall} generatedAt={s.generatedAt} summary={`Operator view · ${summary}`} />
      <Body s={s} />
    </PageShell>
  );
}
