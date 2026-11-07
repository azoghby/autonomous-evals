"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MONITORING_PRICE_CENTS_MONTHLY, type PricingMode, type Remediation } from "@ae/core/contracts/index";
import { api, dollars, errMsg } from "@/lib/client/api";
import { normalizeFinding, type ChargeView, type FindingView, type ProgressItem, type RemediationView } from "@/lib/client/types";
import { AnimatePresence, motion } from "motion/react";
import { Btn, Chip, ErrorBox, Block, Mono } from "./ui";
import { EASE, SOFT, SPRING, Reveal, Stagger } from "./motion";

const STATUS: Record<FindingView["status"], { label: string; tone: "ok" | "warn" | "muted" }> = {
  confirmed: { label: "Confirmed", tone: "ok" },
  rubric_concern: { label: "Rubric concern", tone: "warn" },
  inconclusive: { label: "Inconclusive", tone: "muted" },
};
type VerifyStatus = Remediation["verification"]["status"];
const VERIFY: Record<VerifyStatus, { label: string; tone: "info" | "warn" | "bad" }> = {
  verified: { label: "Verified", tone: "info" },
  partially_verified: { label: "Partially verified", tone: "warn" },
  not_verified: { label: "Not verified", tone: "bad" },
};

function PassBar({ label, v }: { label: string; v?: { passed: number; total: number } }) {
  const pct = v && v.total > 0 ? Math.round((v.passed / v.total) * 100) : 0;
  return (
    <div className="flex items-center gap-3 font-mono text-xs text-muted">
      <span className="w-12 text-subtle">{label}</span>
      <span className="h-1 w-24 overflow-hidden rounded-sm bg-line"><span className="block h-full bg-accent" style={{ width: `${pct}%` }} /></span>
      <span className="tabular-nums text-fg">{v ? `${v.passed}/${v.total}` : "n/a"}</span>
    </div>
  );
}

function RemediationBlock({ r }: { r: RemediationView }) {
  const [copied, setCopied] = useState(false);
  const v = r.verification;
  const vs = v ? VERIFY[v.status] : undefined;
  async function copy() {
    try { await navigator.clipboard.writeText(r.patch ?? ""); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard unavailable */ }
  }
  return (
    <div className="mt-6 border-l border-line-strong pl-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <h4 className="font-mono text-[11px] uppercase tracking-[0.14em] text-subtle">Fix · {r.kind.replace(/_/g, " ")}</h4>
        {vs && <Chip tone={vs.tone}>{vs.label}</Chip>}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-fg/90">{r.summary}</p>
      {v && (
        <div className="mt-3 space-y-1.5">
          <PassBar label="before" v={v.before} />
          <PassBar label="after" v={v.after} />
          <div className="font-mono text-xs text-subtle">{v.regressions ?? 0} regression{(v.regressions ?? 0) === 1 ? "" : "s"}</div>
        </div>
      )}
      {r.patch && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted transition hover:text-fg">View patch</summary>
          <div className="relative mt-2">
            <Mono>{r.patch}</Mono>
            <button type="button" onClick={copy} className="absolute right-2 top-2 rounded-md border border-line-strong bg-bg px-2 py-1 text-[11px] text-muted transition hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">{copied ? "Copied" : "Copy"}</button>
          </div>
        </details>
      )}
    </div>
  );
}

const SEV_TONE = { critical: "bad", high: "bad", medium: "warn", low: "muted" } as const;

function FindingCard({ jobId, f, onRerun, fixes }: { jobId: string; f: FindingView; onRerun: () => Promise<void>; fixes: RemediationView[] }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const st = STATUS[f.status] ?? STATUS.inconclusive;

  async function rerun() {
    setBusy(true); setError(null);
    try {
      // Server responds 201 {finding: <findings row>} and expects the row uuid (f.id), not the contract key.
      const r = await api<{ finding: unknown }>(`/api/jobs/${jobId}/findings/${encodeURIComponent(f.id)}/rerun`, { method: "POST" });
      const again = normalizeFinding(r.finding);
      setResult(`${STATUS[again.status]?.label ?? again.status}${again.reproductions ? ` (${again.reproductions} reproduction${again.reproductions === 1 ? "" : "s"})` : ""}`);
      await onRerun();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  const [open, setOpen] = useState(false);
  return (
    <motion.li layout transition={{ layout: { duration: 0.4, ease: EASE } }} variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: SOFT } }}
      className="overflow-hidden border-b border-line">
      <motion.button layout="position" type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start justify-between gap-4 py-5 text-left focus-visible:outline-2 focus-visible:outline-accent">
        <div className="min-w-0">
          <h3 className="text-base font-medium">{f.title}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1">
            <Chip tone={st.tone}>{st.label}</Chip>
            <Chip tone={SEV_TONE[f.severity] ?? "muted"}>{f.severity}</Chip>
            <span className="text-xs text-subtle">{f.category.replace(/_/g, " ")}</span>
          </div>
        </div>
        <motion.span aria-hidden animate={{ rotate: open ? 45 : 0 }} transition={SPRING} className="mt-1 font-mono text-xl leading-none text-subtle">+</motion.span>
      </motion.button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="body" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease: EASE }} className="pb-6">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{f.description}</p>
            {f.evidence.length > 0 && (
              <div className="mt-5 space-y-3">
                <h4 className="text-xs uppercase tracking-[0.14em] text-subtle">Evidence</h4>
                {f.evidence.map((ev, i) => (
                  <div key={i}>
                    <div className="mb-1 text-xs text-subtle">{ev.kind.replace(/_/g, " ")}{ev.location ? ` · ${ev.location}` : ""}</div>
                    <Mono>{ev.excerpt}</Mono>
                  </div>
                ))}
              </div>
            )}
            {fixes.map((r) => <RemediationBlock key={r.id} r={r} />)}
            <div className="mt-5 flex flex-wrap items-center gap-4">
              {f.rerunOf ? <Chip tone="info">Re-run result</Chip> : <Btn variant="ghost" onClick={rerun} loading={busy}>Re-run this finding</Btn>}
              {f.reproductions ? <span className="text-xs text-subtle">{f.reproductions} reproduction(s)</span> : null}
              {result && <span role="status" className="text-xs text-muted">Re-run: {result}</span>}
              {error && <span role="alert" className="text-xs text-accent-bright">{error}</span>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

export function ReportView({ jobId, report, findings, progress, onReload, remediations = [], charge = null, pricingMode = "fixed" }: {
  jobId: string; report: { summary: string } | null; findings: FindingView[]; progress: ProgressItem[]; onReload: () => Promise<void>;
  remediations?: RemediationView[]; charge?: ChargeView | null; pricingMode?: PricingMode;
}) {
  const retestKey = useRef<string>(crypto.randomUUID());
  const router = useRouter();
  const [retestBusy, setRetestBusy] = useState(false);
  const [monBusy, setMonBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const originals = findings.filter((f) => !f.rerunOf);
  const fixesFor = (f: FindingView) => remediations.filter((r) => r.findingRowId === f.id || r.findingId === f.key);
  const verified = remediations.filter((r) => r.verification.status === "verified").length;
  const confirmed = originals.filter((f) => f.status === "confirmed").length;
  const chargeLine = pricingMode === "per_finding" && charge
    ? (charge.status === "released" || !(charge.capturedAmountCents ?? 0)
        ? (charge.status === "authorized" ? null : "Hold released. You paid $0.")
        : `Charged ${dollars(charge.capturedAmountCents ?? 0)} for ${confirmed} confirmed finding${confirmed === 1 ? "" : "s"}.`)
    : null;

  async function retest() {
    setRetestBusy(true); setError(null);
    try {
      const r = await api<{ jobId: string }>(`/api/jobs/${jobId}/retest`, { method: "POST", headers: { "Idempotency-Key": retestKey.current } });
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
    <Reveal className="space-y-12">
      <Block title="Report summary" aside={
        <div className="flex gap-5 text-sm">
          <a className="text-fg/90 underline decoration-line-strong underline-offset-4 transition hover:text-fg hover:decoration-accent-bright" href={`/api/jobs/${jobId}/artifacts/report`}>Download report</a>
          <a className="text-fg/90 underline decoration-line-strong underline-offset-4 transition hover:text-fg hover:decoration-accent-bright" href={`/api/jobs/${jobId}/artifacts/suite`}>Download suite</a>
        </div>}>
        <p className="max-w-2xl whitespace-pre-wrap text-[15px] leading-relaxed text-fg/90">{report?.summary || "No summary was written for this report."}</p>
        <p className="mt-4 font-mono text-xs text-muted"><span className="text-accent-bright">{originals.length}</span> findings · <span className="text-accent-bright">{verified}</span> fixes verified</p>
        {chargeLine && <p className="mt-2 font-mono text-xs text-muted">{chargeLine}</p>}
      </Block>

      <section aria-labelledby="findings-h">
        <h2 id="findings-h" className="mb-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-subtle">Findings · {originals.length}</h2>
        {findings.length === 0 ? (
          <p className="border-t border-line pt-5 text-sm text-muted">No findings were reported. This does not prove the system is correct; it means nothing we checked was confirmed as a problem.</p>
        ) : (
          <Stagger as="ul" className="border-t border-line">{findings.map((f, i) => <FindingCard key={`${f.id}-${i}`} jobId={jobId} f={f} onRerun={onReload} fixes={fixesFor(f)} />)}</Stagger>
        )}
      </section>

      <AnimatePresence>{error && <ErrorBox key="e" message={error} />}</AnimatePresence>

      <div className="grid gap-x-12 gap-y-8 border-t border-line pt-6 sm:grid-cols-2">
        <div>
          <h3 className="font-medium">Linked retest</h3>
          <p className="mt-1 text-sm text-muted">Fixed something? Run the same frozen checks again as a new linked job.</p>
          <Btn className="mt-4" variant="ghost" onClick={retest} loading={retestBusy}>Request linked retest</Btn>
        </div>
        <div>
          <h3 className="font-medium">Monitoring pilot</h3>
          <p className="mt-1 text-sm text-muted">Nightly re-run of your frozen suite with an email alert on regressions. {dollars(MONITORING_PRICE_CENTS_MONTHLY)}/month.</p>
          <Btn className="mt-4" onClick={monitor} loading={monBusy}>Start monitoring · {dollars(MONITORING_PRICE_CENTS_MONTHLY)}/mo</Btn>
        </div>
      </div>

      {progress.length > 0 && (
        <details className="group border-t border-line pt-5 text-sm">
          <summary className="cursor-pointer text-muted transition hover:text-fg">How this job ran</summary>
          <ul className="mt-3 space-y-1 text-muted">{progress.map((p, i) => <li key={i}>{p.message}</li>)}</ul>
        </details>
      )}
    </Reveal>
  );
}
