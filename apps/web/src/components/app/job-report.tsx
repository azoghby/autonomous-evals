"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MONITORING_PRICE_CENTS_MONTHLY, PER_FINDING_CAP_CENTS, PER_FINDING_CENTS, type PricingMode, type Remediation } from "@ae/core/contracts/index";
import { api, dollars, errMsg } from "@/lib/client/api";
import { normalizeFinding, type ChargeView, type FindingView, type ProgressItem, type QuoteView, type RemediationView } from "@/lib/client/types";
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

function PatchView({ patch }: { patch: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(patch); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard unavailable */ }
  }
  return (
    <div className="relative mt-2">
      <Mono>{patch}</Mono>
      <button type="button" onClick={copy} className="absolute right-2 top-2 rounded-md border border-line-strong bg-bg px-2 py-1 text-[11px] text-muted transition hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">{copied ? "Copied" : "Copy patch"}</button>
    </div>
  );
}

const DOT = { info: "bg-accent-bright", warn: "bg-amber-400", bad: "bg-red-500" } as const;

function ValidatedFixes({ fixes, titleFor }: { fixes: RemediationView[]; titleFor: (r: RemediationView) => string }) {
  return (
    <section aria-labelledby="fixes-h">
      <h2 id="fixes-h" className="mb-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-subtle">Validated fixes · {fixes.length}</h2>
      <Stagger as="ul" className="border-t border-line">
        {fixes.map((r) => {
          const v = r.verification;
          const vs = v ? VERIFY[v.status] : undefined;
          return (
            <motion.li key={r.id} variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: SOFT } }} className="border-b border-line py-5">
              <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
                <div className="min-w-0">
                  <h3 className="text-base font-medium">{titleFor(r)}</h3>
                  <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-subtle">{r.kind.replace(/_/g, " ")}</p>
                </div>
                {vs && (
                  <span className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-muted">
                    <span aria-hidden className={`h-2 w-2 rounded-full ${DOT[vs.tone]}`} />{vs.label}
                  </span>
                )}
              </div>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-fg/90">{r.summary}</p>
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
                  <PatchView patch={r.patch} />
                </details>
              )}
            </motion.li>
          );
        })}
      </Stagger>
    </section>
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

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const SEV_DOT = { critical: "bg-red-500", high: "bg-red-500", medium: "bg-amber-400", low: "bg-subtle" } as const;
const DOWNLOADS = [
  { kind: "report", label: "Report (.md)" },
  { kind: "suite", label: "Suite (JSON)" },
  { kind: "evidence", label: "Evidence" },
] as const;

function chargeSummary(opts: { pricingMode: PricingMode; charge: ChargeView | null; quote: QuoteView | null; confirmed: number }): string | null {
  const { pricingMode, charge, quote, confirmed } = opts;
  const captured = charge?.capturedAmountCents ?? 0;
  if (pricingMode === "per_finding") {
    if (!charge || charge.status === "authorized") return null;
    if (charge.status === "released" || !captured) return "Hold released. You paid $0.";
    const cap = quote?.capCents ?? (quote ? PER_FINDING_CAP_CENTS[quote.package] : undefined);
    return `Charged ${dollars(captured)}. ${confirmed} confirmed finding${confirmed === 1 ? "" : "s"} × ${dollars(PER_FINDING_CENTS)}${cap ? ` (cap ${dollars(cap)})` : ""}`;
  }
  const amount = captured || quote?.priceCents || charge?.amountCents;
  return amount ? `Charged ${dollars(amount)}. Fixed price for the full ${quote ? "package" : "report"}, regardless of findings.` : null;
}

export function ReportView({ jobId, report, findings, progress, onReload, remediations = [], charge = null, pricingMode = "fixed", quote = null }: {
  jobId: string; report: { summary: string } | null; findings: FindingView[]; progress: ProgressItem[]; onReload: () => Promise<void>;
  remediations?: RemediationView[]; charge?: ChargeView | null; pricingMode?: PricingMode; quote?: QuoteView | null;
}) {
  const retestKey = useRef<string>(crypto.randomUUID());
  const router = useRouter();
  const [retestBusy, setRetestBusy] = useState(false);
  const [monBusy, setMonBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const originals = findings.filter((f) => !f.rerunOf);
  const fixesFor = (f: FindingView) => remediations.filter((r) => r.findingRowId === f.id || r.findingId === f.key);
  const fixTitle = (r: RemediationView) => originals.find((f) => f.id === r.findingRowId || f.key === r.findingId)?.title ?? "Finding";
  const verified = remediations.filter((r) => r.verification.status === "verified").length;
  const confirmed = originals.filter((f) => f.status === "confirmed").length;
  const sevCounts = SEVERITIES.map((s) => ({ s, n: originals.filter((f) => f.severity === s).length })).filter((x) => x.n > 0);
  const chargeLine = chargeSummary({ pricingMode, charge, quote, confirmed });

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
      <Block title="Report summary">
        <p className="max-w-2xl whitespace-pre-wrap text-[15px] leading-relaxed text-fg/90">{report?.summary || "No summary was written for this report."}</p>
        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-xs text-muted">
          <span><span className="text-accent-bright">{originals.length}</span> findings</span>
          {sevCounts.map(({ s, n }) => (
            <span key={s} className="inline-flex items-center gap-2"><span aria-hidden className={`h-1.5 w-1.5 rounded-full ${SEV_DOT[s]}`} /><span className="tabular-nums text-fg">{n}</span> {s}</span>
          ))}
          <span><span className="text-accent-bright">{verified}</span> of {remediations.length} fixes verified</span>
        </div>
        {chargeLine && <p className="mt-3 font-mono text-xs text-muted">{chargeLine}</p>}
        <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-4 text-sm" role="group" aria-label="Downloads">
          {DOWNLOADS.map((d) => (
            <a key={d.kind} download className="text-fg/90 underline decoration-line-strong underline-offset-4 transition hover:text-fg hover:decoration-accent-bright focus-visible:outline-2 focus-visible:outline-accent" href={`/api/jobs/${jobId}/artifacts/${d.kind}`}>{d.label}</a>
          ))}
        </div>
      </Block>

      {remediations.length > 0 && <ValidatedFixes fixes={remediations} titleFor={fixTitle} />}

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
