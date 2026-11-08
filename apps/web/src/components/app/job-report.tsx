"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Download } from "lucide-react";
import { MONITORING_PRICE_CENTS_MONTHLY, PER_FINDING_CAP_CENTS, PER_FINDING_CENTS, type PricingMode, type Remediation } from "@ae/core/contracts/index";
import { api, dollars, errMsg } from "@/lib/client/api";
import { normalizeFinding, type ChargeView, type FindingView, type ProgressItem, type QuoteView, type RemediationView } from "@/lib/client/types";
import { AnimatePresence } from "motion/react";
import { Button, Chip, Stat, StatusChip, type ChipTone } from "@/components/ui";
import { cx, ErrorBox } from "./ui";
import { Reveal } from "./motion";
import { Panel, SectionLabel } from "./page-parts";
import { GithubPrPanel } from "./github-pr-panel";
import { SharePanel } from "./share-panel";

type VerifyStatus = Remediation["verification"]["status"];
const VERIFY: Record<VerifyStatus, { label: string; tone: ChipTone }> = {
  verified: { label: "Verified", tone: "ok" },
  partially_verified: { label: "Partially verified", tone: "warn" },
  not_verified: { label: "Not verified", tone: "danger" },
};
const SEV_DOT = { critical: "bg-danger", high: "bg-danger", medium: "bg-warn", low: "bg-subtle" } as const;
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const DOWNLOADS = [
  { kind: "report", label: "Report (.md)" },
  { kind: "suite", label: "Suite (JSON)" },
  { kind: "evidence", label: "Evidence" },
] as const;

const kindLabel = (k: string) => k.replace(/_/g, " ");
const isRedTeam = (f: FindingView) => f.id.startsWith("rt-f-") || f.key.startsWith("rt-f-") || !!f.scenarioId?.startsWith("rt_");

/** Renders «canary» spans from red-team evidence as a highlighted mark. */
function Excerpt({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return <>{parts.map((p, i) => p.startsWith("«") && p.endsWith("»")
    ? <mark key={i} className="rounded-[2px] bg-accent-soft px-0.5 text-accent-text outline outline-1 outline-accent/40">{p.slice(1, -1)}</mark>
    : <span key={i}>{p}</span>)}</>;
}

function PassBar({ label, v }: { label: string; v?: { passed: number; total: number } }) {
  const pct = v && v.total > 0 ? Math.round((v.passed / v.total) * 100) : 0;
  const good = label === "after";
  return (
    <div className="grid grid-cols-[48px_1fr_40px] items-center gap-3 t-data">
      <span className="text-subtle">{label}</span>
      <span className="h-1 overflow-hidden rounded-[2px] bg-line-2"><span className={cx("block h-full", good ? "bg-accent" : "bg-line-3")} style={{ width: `${pct}%` }} /></span>
      <span className="text-right text-fg">{v ? `${v.passed}/${v.total}` : "n/a"}</span>
    </div>
  );
}

/** Unified-diff viewer: +/- lines tinted, @@ hunks in accent, copy button in the header strip. */
function PatchView({ patch }: { patch: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(patch); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard unavailable */ }
  }
  return (
    <div className="mt-3 overflow-hidden rounded-[4px] border border-line-2 bg-bg">
      <div className="flex h-9 items-center justify-between border-b border-line px-3">
        <span className="t-eyebrow text-subtle">Patch</span>
        <button type="button" onClick={copy} className="t-eyebrow text-fg-2 transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">{copied ? "Copied" : "Copy patch"}</button>
      </div>
      <pre className="max-h-64 overflow-auto py-2 t-data leading-[1.6]">
        {patch.split("\n").map((line, i) => (
          <span key={i} className={cx("block whitespace-pre px-3",
            line.startsWith("+") && !line.startsWith("+++") && "bg-ok/10 text-ok",
            line.startsWith("-") && !line.startsWith("---") && "bg-danger/10 text-danger",
            line.startsWith("@@") && "text-accent-text",
            (line.startsWith("+++") || line.startsWith("---")) && "text-subtle",
            !/^[+\-@]/.test(line) && "text-fg-2")}>{line || " "}</span>
        ))}
      </pre>
    </div>
  );
}

function FixBody({ r }: { r: RemediationView }) {
  const v = r.verification;
  return (
    <>
      <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-fg-2">{r.summary}</p>
      {v && (
        <div className="mt-4 max-w-md space-y-2">
          <PassBar label="before" v={v.before} />
          <PassBar label="after" v={v.after} />
          <div className="t-data text-subtle">{v.regressions ?? 0} regression{(v.regressions ?? 0) === 1 ? "" : "s"}</div>
        </div>
      )}
      {r.patch && <PatchView patch={r.patch} />}
    </>
  );
}

function ValidatedFixes({ fixes, titleFor }: { fixes: RemediationView[]; titleFor: (r: RemediationView) => string }) {
  return (
    <section aria-labelledby="fixes-h">
      <SectionLabel id="fixes-h">Validated fixes · {fixes.length}</SectionLabel>
      <ul className="overflow-hidden rounded-[4px] border border-line-2 bg-bg-raised">
        {fixes.map((r) => {
          const vs = r.verification ? VERIFY[r.verification.status] : undefined;
          return (
            <li key={r.id} className="border-b border-line p-5 last:border-b-0 sm:p-6">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <h3 className="t-h4 text-fg">{titleFor(r)}</h3>
                <span className="t-eyebrow text-subtle">{kindLabel(r.kind)}</span>
                {vs && <Chip tone={vs.tone} variant="plain" dot>{vs.label}</Chip>}
              </div>
              <FixBody r={r} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RemediationBlock({ r }: { r: RemediationView }) {
  const vs = r.verification ? VERIFY[r.verification.status] : undefined;
  return (
    <div className="mt-6 border-l border-line-3 pl-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h4 className="t-eyebrow text-subtle">Fix · {kindLabel(r.kind)}</h4>
        {vs && <Chip tone={vs.tone} variant="plain" dot>{vs.label}</Chip>}
      </div>
      <FixBody r={r} />
    </div>
  );
}

function FindingRow({ jobId, f, onRerun, fixes }: { jobId: string; f: FindingView; onRerun: () => Promise<void>; fixes: RemediationView[] }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyId = `finding-${f.id}`;

  async function rerun() {
    setBusy(true); setError(null);
    try {
      // Server responds 201 {finding: <findings row>} and expects the row uuid (f.id), not the contract key.
      const r = await api<{ finding: unknown }>(`/api/jobs/${jobId}/findings/${encodeURIComponent(f.id)}/rerun`, { method: "POST" });
      const again = normalizeFinding(r.finding);
      setResult(`${STATUS_LABEL[again.status] ?? again.status}${again.reproductions ? ` (${again.reproductions} reproduction${again.reproductions === 1 ? "" : "s"})` : ""}`);
      await onRerun();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <li className="border-b border-line last:border-b-0">
      <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}
        className="group grid w-full grid-cols-[10px_1fr_16px] items-start gap-x-4 px-5 py-4 text-left transition-colors duration-150 hover:bg-bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent sm:px-6">
        <span aria-hidden className={cx("mt-[9px] size-[7px] rounded-full", SEV_DOT[f.severity] ?? "bg-subtle")} />
        <span className="min-w-0">
          <span className="t-h4 block text-fg">{f.title}</span>
          <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {isRedTeam(f) && <span className="t-eyebrow rounded-[2px] border border-accent px-1.5 py-0.5 text-accent-text">Red-team</span>}
            <StatusChip status={f.status} />
            <span className="t-eyebrow text-subtle">{f.severity}</span>
            <span className="t-eyebrow text-subtle">{kindLabel(f.category)}</span>
          </span>
        </span>
        <ChevronDown aria-hidden size={16} className={cx("mt-1 text-subtle transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <div id={bodyId} className="border-t border-line bg-bg-band px-5 py-5 pl-[46px] sm:px-6 sm:pl-[50px]">
          <p className="max-w-[68ch] whitespace-pre-wrap text-[15px] leading-relaxed text-fg-2">{f.description}</p>
          {f.evidence.length > 0 && (
            <div className="mt-5 space-y-3">
              <h4 className="t-eyebrow text-subtle">Evidence</h4>
              {f.evidence.map((ev, i) => (
                <div key={i}>
                  <div className="t-data mb-1.5 text-subtle">{kindLabel(ev.kind)}{ev.location ? ` · ${ev.location}` : ""}</div>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[4px] border border-line-2 bg-bg p-3 t-data leading-relaxed text-fg-2"><Excerpt text={ev.excerpt} /></pre>
                </div>
              ))}
            </div>
          )}
          {fixes.map((r) => <RemediationBlock key={r.id} r={r} />)}
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
            {f.rerunOf ? <Chip tone="info">Re-run result</Chip> : <Button variant="outline" size="sm" onClick={rerun} disabled={busy}>{busy ? "Re-running…" : "Re-run this finding"}</Button>}
            {f.reproductions ? <span className="text-xs text-subtle">{f.reproductions} reproduction(s)</span> : null}
            {result && <span role="status" className="text-xs text-muted">Re-run: {result}</span>}
            {error && <span role="alert" className="text-xs text-danger">{error}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

const STATUS_LABEL: Record<FindingView["status"], string> = { confirmed: "Confirmed", rubric_concern: "Rubric concern", inconclusive: "Inconclusive" };

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
  const redTeam = originals.filter(isRedTeam);
  const standard = findings.filter((f) => !(isRedTeam(f) && !f.rerunOf));
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
      <Panel title="Report summary">
        <p className="max-w-[68ch] whitespace-pre-wrap text-[16px] leading-relaxed text-fg">{report?.summary || "No summary was written for this report."}</p>
        <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-[4px] border border-line-2 bg-line-2 sm:grid-cols-3">
          <Stat className="bg-bg p-4 sm:p-5" label="Findings" value={originals.length} hint={`${confirmed} confirmed`} />
          <Stat className="bg-bg p-4 sm:p-5" label="Fixes verified" value={`${verified}/${remediations.length}`} hint={`${verified} of ${remediations.length} fixes verified`} />
          <Stat className="col-span-2 bg-bg p-4 sm:col-span-1 sm:p-5" label="High severity" value={originals.filter((f) => f.severity === "critical" || f.severity === "high").length} hint="critical + high" />
        </div>
        {sevCounts.length > 0 && (
          <p className="t-data mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-muted">
            {sevCounts.map(({ s, n }) => (
              <span key={s} className="inline-flex items-center gap-2"><span aria-hidden className={cx("size-1.5 rounded-full", SEV_DOT[s])} /><span className="text-fg">{n}</span> {s}</span>
            ))}
          </p>
        )}
        {chargeLine && <p className="t-data mt-3 text-muted">{chargeLine}</p>}
        <div className="mt-6 flex flex-wrap gap-3 border-t border-line pt-5" role="group" aria-label="Downloads">
          {DOWNLOADS.map((d) => (
            <a key={d.kind} download href={`/api/jobs/${jobId}/artifacts/${d.kind}`}
              className="inline-flex h-8 items-center gap-2 rounded-[4px] border border-line-3 px-3 text-sm font-medium text-fg transition-colors duration-150 hover:border-[#5a5e66] hover:bg-bg-hover active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              <Download aria-hidden size={14} className="text-subtle" />{d.label}
            </a>
          ))}
        </div>
      </Panel>

      {remediations.length > 0 && <ValidatedFixes fixes={remediations} titleFor={fixTitle} />}
      {remediations.length > 0 && (
        <GithubPrPanel jobId={jobId} remediations={remediations.map((r) => ({ id: r.id, summary: r.summary, verificationStatus: r.verification.status }))} />
      )}

      <section aria-labelledby="findings-h">
        <SectionLabel id="findings-h">Findings · {originals.length - redTeam.length}</SectionLabel>
        {findings.length === 0 ? (
          <p className="rounded-[4px] border border-line-2 bg-bg-raised p-5 text-[15px] text-muted">No findings were reported. This does not prove the system is correct; it means nothing we checked was confirmed as a problem.</p>
        ) : standard.length > 0 ? (
          <ul className="overflow-hidden rounded-[4px] border border-line-2 bg-bg-raised">{standard.map((f, i) => <FindingRow key={`${f.id}-${i}`} jobId={jobId} f={f} onRerun={onReload} fixes={fixesFor(f)} />)}</ul>
        ) : null}
      </section>

      {redTeam.length > 0 && (
        <section aria-labelledby="redteam-h">
          <SectionLabel id="redteam-h">Red-team · {redTeam.length}</SectionLabel>
          <p className="t-data mb-3 text-muted">{redTeam.length} red-team finding{redTeam.length === 1 ? "" : "s"} · {redTeam.filter((f) => f.status === "confirmed").length} confirmed. Adversarial prompts that made your agent break a rule.</p>
          <ul className="overflow-hidden rounded-[4px] border border-line-2 bg-bg-raised">
            {findings.filter(isRedTeam).map((f, i) => <FindingRow key={`${f.id}-${i}`} jobId={jobId} f={f} onRerun={onReload} fixes={fixesFor(f)} />)}
          </ul>
        </section>
      )}

      <SharePanel jobId={jobId} />

      <AnimatePresence>{error && <ErrorBox key="e" message={error} />}</AnimatePresence>

      <div className="grid gap-4 sm:grid-cols-2">
        <Panel title="Linked retest" className="flex flex-col" bodyClassName="flex flex-1 flex-col">
          <p className="text-[15px] text-muted">Fixed something? Run the same frozen checks again as a new linked job.</p>
          <div className="mt-auto pt-5"><Button variant="outline" onClick={retest} disabled={retestBusy}>{retestBusy ? "Requesting…" : "Request linked retest"}</Button></div>
        </Panel>
        <Panel title="Monitoring pilot" className="flex flex-col" bodyClassName="flex flex-1 flex-col">
          <p className="text-[15px] text-muted">Nightly re-run of your frozen suite with an email alert on regressions. {dollars(MONITORING_PRICE_CENTS_MONTHLY)}/month.</p>
          <div className="mt-auto pt-5"><Button onClick={monitor} disabled={monBusy}>{monBusy ? "Redirecting…" : `Start monitoring · ${dollars(MONITORING_PRICE_CENTS_MONTHLY)}/mo`}</Button></div>
        </Panel>
      </div>

      {progress.length > 0 && (
        <details className="group border-t border-line pt-5 text-sm">
          <summary className="t-eyebrow flex cursor-pointer list-none items-center gap-2 text-subtle transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
            <ChevronDown aria-hidden size={14} className="-rotate-90 transition-transform group-open:rotate-0" />How this job ran
          </summary>
          <ul className="mt-4 space-y-1.5 pl-6 text-[13px] text-muted">{progress.map((p, i) => <li key={i}>{p.message}</li>)}</ul>
        </details>
      )}
    </Reveal>
  );
}
