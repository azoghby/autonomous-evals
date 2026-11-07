"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MONITORING_PRICE_CENTS_MONTHLY } from "@ae/core/contracts/index";
import { api, dollars, errMsg } from "@/lib/client/api";
import { normalizeFinding, type FindingView, type ProgressItem } from "@/lib/client/types";
import { AnimatePresence, motion } from "motion/react";
import { Btn, Chip, ErrorBox, Block, Mono } from "./ui";
import { EASE, SOFT, SPRING, Reveal, Stagger } from "./motion";

const STATUS: Record<FindingView["status"], { label: string; tone: "ok" | "warn" | "muted" }> = {
  confirmed: { label: "Confirmed", tone: "ok" },
  rubric_concern: { label: "Rubric concern", tone: "warn" },
  inconclusive: { label: "Inconclusive", tone: "muted" },
};
const SEV_TONE = { critical: "bad", high: "bad", medium: "warn", low: "muted" } as const;

function FindingCard({ jobId, f, onRerun }: { jobId: string; f: FindingView; onRerun: () => Promise<void> }) {
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
      className="overflow-hidden border-b border-white/10">
      <motion.button layout="position" type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start justify-between gap-4 py-5 text-left focus-visible:outline-2 focus-visible:outline-cream">
        <div className="min-w-0">
          <h3 className="text-base font-medium">{f.title}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1">
            <Chip tone={st.tone}>{st.label}</Chip>
            <Chip tone={SEV_TONE[f.severity] ?? "muted"}>{f.severity}</Chip>
            <span className="text-xs text-cream/40">{f.category.replace(/_/g, " ")}</span>
          </div>
        </div>
        <motion.span aria-hidden animate={{ rotate: open ? 45 : 0 }} transition={SPRING} className="mt-1 text-xl leading-none text-cream/50">+</motion.span>
      </motion.button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="body" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease: EASE }} className="pb-6">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-cream/75">{f.description}</p>
            {f.evidence.length > 0 && (
              <div className="mt-5 space-y-3">
                <h4 className="text-xs uppercase tracking-[0.14em] text-cream/40">Evidence</h4>
                {f.evidence.map((ev, i) => (
                  <div key={i}>
                    <div className="mb-1 text-xs text-cream/45">{ev.kind.replace(/_/g, " ")}{ev.location ? ` · ${ev.location}` : ""}</div>
                    <Mono>{ev.excerpt}</Mono>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-4">
              {f.rerunOf ? <Chip tone="info">Re-run result</Chip> : <Btn variant="ghost" onClick={rerun} loading={busy}>Re-run this finding</Btn>}
              {f.reproductions ? <span className="text-xs text-cream/45">{f.reproductions} reproduction(s)</span> : null}
              {result && <span role="status" className="text-xs text-cream/70">Re-run: {result}</span>}
              {error && <span role="alert" className="text-xs text-coral">{error}</span>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

export function ReportView({ jobId, report, findings, progress, onReload }: {
  jobId: string; report: { summary: string } | null; findings: FindingView[]; progress: ProgressItem[]; onReload: () => Promise<void>;
}) {
  const retestKey = useRef<string>(crypto.randomUUID());
  const router = useRouter();
  const [retestBusy, setRetestBusy] = useState(false);
  const [monBusy, setMonBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const originals = findings.filter((f) => !f.rerunOf);

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
          <a className="text-cream/80 underline decoration-cream/20 underline-offset-4 transition hover:text-cream hover:decoration-cream" href={`/api/jobs/${jobId}/artifacts/report`}>Download report</a>
          <a className="text-cream/80 underline decoration-cream/20 underline-offset-4 transition hover:text-cream hover:decoration-cream" href={`/api/jobs/${jobId}/artifacts/suite`}>Download suite</a>
        </div>}>
        <p className="max-w-2xl whitespace-pre-wrap text-[15px] leading-relaxed text-cream/85">{report?.summary || "No summary was written for this report."}</p>
      </Block>

      <section aria-labelledby="findings-h">
        <h2 id="findings-h" className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-cream/50">Findings · {originals.length}</h2>
        {findings.length === 0 ? (
          <p className="border-t border-white/10 pt-5 text-sm text-cream/65">No findings were reported. This does not prove the system is correct; it means nothing we checked was confirmed as a problem.</p>
        ) : (
          <Stagger as="ul" className="border-t border-white/10">{findings.map((f, i) => <FindingCard key={`${f.id}-${i}`} jobId={jobId} f={f} onRerun={onReload} />)}</Stagger>
        )}
      </section>

      <AnimatePresence>{error && <ErrorBox key="e" message={error} />}</AnimatePresence>

      <div className="grid gap-x-12 gap-y-8 border-t border-white/10 pt-6 sm:grid-cols-2">
        <div>
          <h3 className="font-medium">Linked retest</h3>
          <p className="mt-1 text-sm text-cream/60">Fixed something? Run the same frozen checks again as a new linked job.</p>
          <Btn className="mt-4" variant="ghost" onClick={retest} loading={retestBusy}>Request linked retest</Btn>
        </div>
        <div>
          <h3 className="font-medium">Monitoring pilot</h3>
          <p className="mt-1 text-sm text-cream/60">Nightly re-run of your frozen suite with an email alert on regressions. {dollars(MONITORING_PRICE_CENTS_MONTHLY)}/month.</p>
          <Btn className="mt-4" onClick={monitor} loading={monBusy}>Start monitoring · {dollars(MONITORING_PRICE_CENTS_MONTHLY)}/mo</Btn>
        </div>
      </div>

      {progress.length > 0 && (
        <details className="group border-t border-white/10 pt-5 text-sm">
          <summary className="cursor-pointer text-cream/70 transition hover:text-cream">How this job ran</summary>
          <ul className="mt-3 space-y-1 text-cream/55">{progress.map((p, i) => <li key={i}>{p.message}</li>)}</ul>
        </details>
      )}
    </Reveal>
  );
}
