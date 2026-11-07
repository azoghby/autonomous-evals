"use client";
import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { PER_FINDING_CAP_CENTS, PER_FINDING_CENTS, PRICE_CENTS } from "@ae/core/contracts/index";
import type { Finding, Remediation } from "@ae/core/contracts/index";
import { Button, NudgeArrow, PageShell, Reveal, StatusChip, cn } from "@/components/ui";
import { sampleFindings, sampleMeta, sampleRemediations, sampleReport } from "./sample-report";

const usd = (cents: number) => `$${cents / 100}`;
const FIXED = usd(PRICE_CENTS.trace_audit);
const CAP = usd(PER_FINDING_CAP_CENTS.trace_audit);
const PER = usd(PER_FINDING_CENTS);
const confirmedCount = sampleFindings.filter((f) => f.status === "confirmed").length;
const PER_TOTAL = usd(Math.min(confirmedCount * PER_FINDING_CENTS, PER_FINDING_CAP_CENTS.trace_audit));

const SEVERITY_STYLE: Record<Finding["severity"], string> = {
  critical: "text-danger border-danger/40",
  high: "text-warn border-warn/40",
  medium: "text-accent-bright border-accent/40",
  low: "text-muted border-line-strong",
};
const KIND_LABEL: Record<Remediation["kind"], string> = {
  prompt_patch: "Prompt patch", tool_schema: "Tool schema", guardrail: "Guardrail", other: "Other",
};
const TOOLTIP = "Available on your own reports";

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-subtle">{children}</p>;
}

function RerunButton({ id }: { id: string }) {
  return (
    <span className="group/tip relative inline-flex" tabIndex={0} aria-describedby={`tip-${id}`}>
      <Button variant="outline" size="sm" disabled aria-label={`Re-run ${id}`}>Re-run this finding</Button>
      <span
        id={`tip-${id}`}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-line-strong bg-bg-raised px-3 py-1.5 text-xs text-fg opacity-0 transition-opacity duration-150 group-hover/tip:opacity-100 group-focus-visible/tip:opacity-100 group-focus-within/tip:opacity-100"
      >
        {TOOLTIP}
      </span>
    </span>
  );
}

function EvidenceBlock({ finding, defaultOpen }: { finding: Finding; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const reduce = useReducedMotion();
  const panelId = `ev-${finding.id}`;
  return (
    <motion.div layout={reduce ? false : "position"} className="mt-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="group inline-flex items-center gap-2 rounded-md py-1 font-mono text-xs uppercase tracking-wider text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-bright"
      >
        <span aria-hidden className={cn("inline-block transition-transform duration-200", open && "rotate-90")}>▸</span>
        Evidence ({finding.evidence.length})
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            id={panelId}
            layout={reduce ? false : "position"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0.12 : 0.25 }}
            className="mt-3 space-y-3"
          >
            {finding.evidence.map((e, i) => (
              <li key={i}>
                <div className="mb-1.5 flex flex-wrap items-center gap-x-3 font-mono text-[11px] uppercase tracking-wider text-subtle">
                  <span className="text-accent-bright">{e.location ?? "trace"}</span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words border border-line bg-black/60 p-4 font-mono text-[13px] leading-relaxed text-fg"><code>{e.excerpt}</code></pre>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function FindingCard({ finding, index }: { finding: Finding; index: number }) {
  return (
    <Reveal as="article" className="border-t border-line py-10 first:border-t-0">
      <div className="grid gap-6 md:grid-cols-[9rem_1fr]">
        <div className="flex items-center gap-3 md:flex-col md:items-start md:gap-3">
          <span className="font-mono text-sm text-subtle">{finding.id}</span>
          <span className={cn("inline-block rounded-md border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider", SEVERITY_STYLE[finding.severity])}>{finding.severity}</span>
          <StatusChip status={finding.status} />
        </div>
        <div>
          <p className="font-mono text-[11px] uppercase tracking-wider text-subtle">{finding.category.replace(/_/g, " ")}</p>
          <h3 className="mt-2 text-2xl font-medium tracking-tight sm:text-[1.75rem] sm:leading-tight">{finding.title}</h3>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">{finding.description}</p>
          <EvidenceBlock finding={finding} defaultOpen={index === 0} />
          <div className="mt-6 flex flex-wrap items-center gap-4">
            {finding.status === "confirmed" ? (
              <p className="font-mono text-xs text-ok">Reproduced {finding.reproductions} / 3</p>
            ) : (
              <p className="font-mono text-xs text-subtle">Not counted toward confirmed findings</p>
            )}
            <RerunButton id={finding.id} />
          </div>
        </div>
      </div>
    </Reveal>
  );
}

function PassBar({ label, passed, total, tone }: { label: string; passed: number; total: number; tone: "before" | "after" }) {
  const reduce = useReducedMotion();
  const ratio = total === 0 ? 0 : passed / total;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between font-mono text-xs">
        <span className="uppercase tracking-wider text-subtle">{label}</span>
        <span className={tone === "after" ? "text-accent-bright" : "text-muted"}>{passed}/{total}</span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-[3px] bg-white/[0.08]" role="img" aria-label={`${label}: ${passed} of ${total} passed`}>
        <motion.div
          className={cn("absolute inset-0 origin-left", tone === "after" ? "bg-accent" : "bg-danger")}
          initial={{ scaleX: reduce ? ratio : 0 }}
          whileInView={{ scaleX: ratio }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: reduce ? 0 : 0.9, delay: tone === "after" ? 0.35 : 0, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
    </div>
  );
}

function FixCard({ fix }: { fix: Remediation }) {
  const [showPatch, setShowPatch] = useState(false);
  const reduce = useReducedMotion();
  const title = sampleFindings.find((f) => f.id === fix.findingId)?.title ?? fix.findingId;
  const v = fix.verification;
  return (
    <Reveal as="article" className="border border-line bg-bg-raised p-6 sm:p-8">
      <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] uppercase tracking-wider text-subtle">
        <span className="text-fg">{KIND_LABEL[fix.kind]}</span>
        <span aria-hidden>·</span>
        <span>for {fix.findingId}</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-ok"><span aria-hidden className="inline-block size-1.5 rounded-full bg-ok" />{v.status.replace(/_/g, " ")}</span>
      </div>
      <h3 className="mt-3 text-xl font-medium tracking-tight">{fix.summary}</h3>
      <p className="mt-1 text-sm text-subtle">{title}</p>
      <p className="mt-4 text-[15px] leading-relaxed text-muted">{fix.rationale}</p>
      <div className="mt-8 grid gap-5">
        <PassBar label="Before" passed={v.before.passed} total={v.before.total} tone="before" />
        <PassBar label="After" passed={v.after.passed} total={v.after.total} tone="after" />
      </div>
      <p className="mt-5 font-mono text-xs text-muted">Regressions: <span className="text-fg">{v.regressions}</span></p>
      <motion.div layout={reduce ? false : "position"} className="mt-5">
        <button
          type="button"
          onClick={() => setShowPatch((s) => !s)}
          aria-expanded={showPatch}
          className="inline-flex items-center gap-2 rounded-md py-1 font-mono text-xs uppercase tracking-wider text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-bright"
        >
          <span aria-hidden className={cn("inline-block transition-transform duration-200", showPatch && "rotate-90")}>▸</span>
          {showPatch ? "Hide patch" : "Show patch"}
        </button>
        <AnimatePresence initial={false}>
          {showPatch && (
            <motion.pre
              layout={reduce ? false : "position"}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0.12 : 0.25 }}
              className="mt-3 overflow-x-auto border border-line bg-black/60 p-4 font-mono text-[13px] leading-relaxed text-fg"
            >
              <code>{fix.patch}</code>
            </motion.pre>
          )}
        </AnimatePresence>
      </motion.div>
    </Reveal>
  );
}

function PricingNote() {
  return (
    <Reveal className="grid gap-px border border-line bg-line sm:grid-cols-2">
      <div className="bg-bg p-6 sm:p-8">
        <Eyebrow>Fixed</Eyebrow>
        <p className="mt-3 text-4xl font-medium tracking-tight">{FIXED}</p>
        <p className="mt-2 text-sm text-muted">One flat price for the Trace Audit, however many findings turn up.</p>
      </div>
      <div className="bg-bg p-6 sm:p-8">
        <Eyebrow>Per confirmed finding</Eyebrow>
        <p className="mt-3 text-4xl font-medium tracking-tight">
          {confirmedCount} × {PER} = <span className="text-accent-bright">{PER_TOTAL}</span>
        </p>
        <p className="mt-2 text-sm text-muted">Capped at {CAP}. You are only charged for findings we confirm; this report has {confirmedCount}. Zero confirmed means $0.</p>
      </div>
    </Reveal>
  );
}

export function SampleReport() {
  return (
    <PageShell>
      <header className="pt-10 sm:pt-16">
        <Reveal>
          <p className="inline-flex items-center gap-2 rounded-md border border-accent/50 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-accent-bright">
            {sampleMeta.generatedLabel} · fictional agent
          </p>
        </Reveal>
        <Reveal delay={0.05}>
          <h1 className="mt-6 text-5xl font-medium leading-[1.02] tracking-tight sm:text-7xl">
            {sampleMeta.package}<span className="text-subtle">:</span><br />{sampleMeta.agent}
          </h1>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">{sampleReport.summary}</p>
        </Reveal>
        <Reveal delay={0.15}>
          <dl className="mt-10 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
            {[
              ["Turns audited", String(sampleMeta.traceTurns)],
              ["Claims checked", String(sampleMeta.claimsChecked)],
              ["Confirmed", String(confirmedCount)],
              ["Validated fixes", String(sampleRemediations.length)],
            ].map(([k, v]) => (
              <div key={k} className="bg-bg p-5">
                <dt className="font-mono text-[11px] uppercase tracking-wider text-subtle">{k}</dt>
                <dd className="mt-2 text-3xl font-medium tracking-tight text-fg">{v}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
        <Reveal delay={0.2} className="mt-6">
          <a
            href="/sample/suite.json"
            download="sample-suite.json"
            className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted underline-offset-[6px] decoration-accent-bright transition-colors hover:text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-bright"
          >
            Download sample suite JSON <span aria-hidden>↓</span>
          </a>
        </Reveal>
      </header>

      <section aria-labelledby="findings-h" className="mt-24">
        <Reveal><Eyebrow>01 · Findings</Eyebrow></Reveal>
        <h2 id="findings-h" className="sr-only">Findings</h2>
        <div className="mt-6">
          {sampleFindings.map((f, i) => <FindingCard key={f.id} finding={f} index={i} />)}
        </div>
      </section>

      <section aria-labelledby="fixes-h" className="mt-24">
        <Reveal>
          <Eyebrow>02 · Validated fixes</Eyebrow>
          <h2 id="fixes-h" className="mt-3 max-w-xl text-3xl font-medium tracking-tight sm:text-4xl">We do not just find problems. We prove the fix works.</h2>
          <p className="mt-3 max-w-xl text-muted">Each fix is re-checked against the frozen scenarios and the rest of the suite for regressions.</p>
        </Reveal>
        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          {sampleRemediations.map((r) => <FixCard key={r.findingId} fix={r} />)}
        </div>
      </section>

      <section aria-labelledby="pricing-h" className="mt-24">
        <Reveal>
          <Eyebrow>03 · Pricing</Eyebrow>
          <h2 id="pricing-h" className="mb-8 mt-3 text-3xl font-medium tracking-tight sm:text-4xl">Two ways to pay. You choose.</h2>
        </Reveal>
        <PricingNote />
      </section>

      <Reveal as="section" className="mt-24 border-t border-line pt-14">
        <h2 className="max-w-2xl text-4xl font-medium tracking-tight sm:text-5xl">Want this for your agent?</h2>
        <p className="mt-4 max-w-xl text-muted">Send a trace or an endpoint. You get a report like this one, with evidence and fixes you can verify.</p>
        <div className="mt-8"><Button href="/start" size="lg">Get your own eval <NudgeArrow /></Button></div>
      </Reveal>
    </PageShell>
  );
}
