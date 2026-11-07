"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { MONITORING_PRICE_CENTS_MONTHLY } from "@ae/core/contracts/index";
import { api, dollars, errMsg } from "@/lib/client/api";
import type { FindingView, ProgressItem } from "@/lib/client/types";
import { Btn, Chip, ErrorBox, Glass, Mono } from "./ui";

const STATUS: Record<FindingView["status"], { label: string; tone: "ok" | "warn" | "muted" }> = {
  confirmed: { label: "Confirmed", tone: "ok" },
  rubric_concern: { label: "Rubric concern", tone: "warn" },
  inconclusive: { label: "Inconclusive", tone: "muted" },
};
const SEV_TONE = { critical: "bad", high: "bad", medium: "warn", low: "muted" } as const;

function FindingCard({ jobId, f }: { jobId: string; f: FindingView }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const st = STATUS[f.status] ?? STATUS.inconclusive;

  async function rerun() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ state?: string; status?: string } | undefined>(`/api/jobs/${jobId}/findings/${encodeURIComponent(f.id)}/rerun`, { method: "POST" });
      setResult(r?.status ?? r?.state ?? "Re-run requested");
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <li>
      <Glass as="article">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="max-w-xl text-base font-semibold">{f.title}</h3>
          <div className="flex flex-wrap gap-2">
            <Chip tone={st.tone}>{st.label}</Chip>
            <Chip tone={SEV_TONE[f.severity] ?? "muted"}>{f.severity}</Chip>
            <Chip tone="muted">{f.category.replace(/_/g, " ")}</Chip>
          </div>
        </div>
        <p className="mt-3 whitespace-pre-wrap text-sm text-cream/80">{f.description}</p>
        {f.evidence.length > 0 && (
          <div className="mt-4 space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-cream/50">Evidence</h4>
            {f.evidence.map((ev, i) => (
              <div key={i}>
                <div className="mb-1 text-xs text-cream/50">{ev.kind.replace(/_/g, " ")}{ev.location ? ` · ${ev.location}` : ""}</div>
                <Mono>{ev.excerpt}</Mono>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Btn variant="ghost" onClick={rerun} loading={busy}>Re-run this finding</Btn>
          {f.reproductions ? <span className="text-xs text-cream/50">{f.reproductions} reproduction(s)</span> : null}
          {result && <span role="status" className="text-xs text-[#7fd1a8]">Re-run: {result}</span>}
          {error && <span role="alert" className="text-xs text-coral">{error}</span>}
        </div>
      </Glass>
    </li>
  );
}

export function ReportView({ jobId, report, findings, progress }: {
  jobId: string; report: { summary: string } | null; findings: FindingView[]; progress: ProgressItem[];
}) {
  const router = useRouter();
  const [retestBusy, setRetestBusy] = useState(false);
  const [monBusy, setMonBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const originals = findings.filter((f) => !f.rerunOf);

  async function retest() {
    setRetestBusy(true); setError(null);
    try {
      const r = await api<{ jobId: string }>(`/api/jobs/${jobId}/retest`, { method: "POST" });
      router.push(`/jobs/${r.jobId}`);
    } catch (e) { setError(errMsg(e)); setRetestBusy(false); }
  }
  async function monitor() {
    setMonBusy(true); setError(null);
    try {
      const r = await api<{ checkoutUrl: string }>(`/api/jobs/${jobId}/monitoring`, { method: "POST" });
      window.location.assign(r.checkoutUrl);
    } catch (e) { setError(errMsg(e)); setMonBusy(false); }
  }

  return (
    <div className="space-y-6">
      <Glass>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">Report summary</h2>
          <div className="flex flex-wrap gap-2">
            <a className="rounded-full border border-glass-border bg-glass px-4 py-2 text-sm font-semibold hover:bg-glass-strong" href={`/api/jobs/${jobId}/artifacts/report`}>Download report</a>
            <a className="rounded-full border border-glass-border bg-glass px-4 py-2 text-sm font-semibold hover:bg-glass-strong" href={`/api/jobs/${jobId}/artifacts/suite`}>Download test suite</a>
          </div>
        </div>
        <p className="mt-3 whitespace-pre-wrap text-sm text-cream/85">{report?.summary || "No summary was written for this report."}</p>
      </Glass>

      <section aria-labelledby="findings-h">
        <h2 id="findings-h" className="mb-3 text-lg font-semibold">Findings ({originals.length})</h2>
        {findings.length === 0 ? (
          <Glass><p className="text-sm text-cream/75">No findings were reported. This does not prove the system is correct; it means nothing we checked was confirmed as a problem.</p></Glass>
        ) : (
          <ul className="space-y-4">{findings.map((f, i) => <FindingCard key={`${f.id}-${i}`} jobId={jobId} f={f} />)}</ul>
        )}
      </section>

      {error && <ErrorBox message={error} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <Glass>
          <h3 className="font-semibold">Linked retest</h3>
          <p className="mt-1 text-sm text-cream/70">Fixed something? Run the same frozen checks again as a new linked job.</p>
          <Btn className="mt-4" variant="ghost" onClick={retest} loading={retestBusy}>Request linked retest</Btn>
        </Glass>
        <Glass className="border-coral/40">
          <div className="flex items-center gap-2"><h3 className="font-semibold">Monitoring pilot</h3><Chip tone="info">Pilot pricing</Chip></div>
          <p className="mt-1 text-sm text-cream/70">Nightly re-run of your frozen suite with an email alert on regressions. {dollars(MONITORING_PRICE_CENTS_MONTHLY)}/month.</p>
          <Btn className="mt-4" onClick={monitor} loading={monBusy}>Start monitoring · {dollars(MONITORING_PRICE_CENTS_MONTHLY)}/mo</Btn>
        </Glass>
      </div>

      {progress.length > 0 && (
        <details className="rounded-[18px] border border-glass-border bg-glass px-5 py-3 text-sm backdrop-blur-xl">
          <summary className="cursor-pointer font-medium">How this job ran</summary>
          <ul className="mt-3 space-y-1 text-cream/75">{progress.map((p, i) => <li key={i}>{p.message}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
