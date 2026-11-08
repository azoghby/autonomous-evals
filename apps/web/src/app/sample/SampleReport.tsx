"use client";
import { useState } from "react";
import { PER_FINDING_CAP_CENTS, PER_FINDING_CENTS, PRICE_CENTS } from "@ae/core/contracts/index";
import type { Finding, Remediation } from "@ae/core/contracts/index";
import { Button, Eyebrow, Frame, NudgeArrow, PageShell, Stat, StatusChip, cn } from "@/components/ui";
import { sampleFindings, sampleMeta, sampleRemediations, sampleReport } from "./sample-report";

const usd = (cents: number) => `$${cents / 100}`;
const FIXED = usd(PRICE_CENTS.trace_audit);
const CAP = usd(PER_FINDING_CAP_CENTS.trace_audit);
const PER = usd(PER_FINDING_CENTS);
const confirmedCount = sampleFindings.filter((f) => f.status === "confirmed").length;
const PER_TOTAL = usd(Math.min(confirmedCount * PER_FINDING_CENTS, PER_FINDING_CAP_CENTS.trace_audit));

const SEVERITY: Record<Finding["severity"], { dot: string; text: string }> = {
  critical: { dot: "bg-danger", text: "text-danger" },
  high: { dot: "bg-warn", text: "text-warn" },
  medium: { dot: "bg-accent-text", text: "text-accent-text" },
  low: { dot: "bg-subtle", text: "text-muted" },
};
const KIND_LABEL: Record<Remediation["kind"], string> = {
  prompt_patch: "Prompt patch", tool_schema: "Tool schema", guardrail: "Guardrail", other: "Other",
};
const TOOLTIP = "Available on your own reports";

function SectionHead({ index, label, title, lead, id }: { index: string; label: string; title: string; lead?: string; id: string }) {
  return (
    <div className="mb-10 border-t border-line-2 pt-6 sm:mb-12">
      <Eyebrow index={index}>{label}</Eyebrow>
      <h2 id={id} className="t-h2 mt-6 max-w-[22ch] text-balance">{title}</h2>
      {lead && <p className="t-lead mt-4 max-w-[68ch]">{lead}</p>}
    </div>
  );
}

function RerunButton({ id }: { id: string }) {
  return (
    <span className="group/tip relative inline-flex" tabIndex={0} aria-describedby={`tip-${id}`}>
      <Button variant="outline" size="sm" disabled aria-label={`Re-run ${id}`}>Re-run this finding</Button>
      <span
        id={`tip-${id}`}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-20 mb-2 whitespace-nowrap rounded-[4px] border border-line-3 bg-bg-raised px-3 py-1.5 text-xs text-fg opacity-0 transition-opacity duration-150 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
      >
        {TOOLTIP}
      </span>
    </span>
  );
}

function EvidenceBlock({ finding, defaultOpen }: { finding: Finding; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = `ev-${finding.id}`;
  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="group inline-flex h-8 items-center gap-2 font-mono text-[12px] uppercase text-fg-2 transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
      >
        <span aria-hidden className={cn("inline-block text-accent-text transition-transform duration-150", open && "rotate-90")}>▸</span>
        Evidence ({finding.evidence.length})
      </button>
      {open && (
        <ul id={panelId} className="mt-3 space-y-3">
          {finding.evidence.map((e, i) => (
            <li key={i} className="overflow-hidden rounded-[4px] border border-line-2 bg-bg-raised">
              <div className="flex h-9 items-center border-b border-line px-3 font-mono text-[11px] uppercase text-subtle">
                <span className="truncate text-accent-text">{e.location ?? "trace"}</span>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words p-4 font-mono text-[13px] leading-[1.6] text-fg-2"><code>{e.excerpt}</code></pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FindingRow({ finding, index }: { finding: Finding; index: number }) {
  const sev = SEVERITY[finding.severity];
  return (
    <article className="grid gap-6 border-b border-line-2 py-10 first:pt-0 last:border-b-0 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-12">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 lg:flex-col lg:items-start lg:gap-3">
        <span className="t-data text-subtle">{finding.id}</span>
        <span className={cn("inline-flex items-center gap-2 font-mono text-[12px] uppercase", sev.text)}>
          <span aria-hidden className={cn("size-1.5 rounded-full", sev.dot)} />{finding.severity}
        </span>
        <StatusChip status={finding.status} />
      </div>
      <div className="min-w-0">
        <p className="t-eyebrow text-subtle">{finding.category.replace(/_/g, " ")}</p>
        <h3 className="t-h3 mt-3 max-w-[40ch] text-balance text-fg">{finding.title}</h3>
        <p className="t-body mt-4 max-w-[68ch] text-muted">{finding.description}</p>
        <EvidenceBlock finding={finding} defaultOpen={index === 0} />
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
          {finding.status === "confirmed" ? (
            <p className="inline-flex items-center gap-2 font-mono text-[12px] text-ok"><span aria-hidden className="size-1.5 rounded-full bg-ok" />Reproduced {finding.reproductions} / 3</p>
          ) : (
            <p className="font-mono text-[12px] text-subtle">Not counted toward confirmed findings</p>
          )}
          <RerunButton id={finding.id} />
        </div>
      </div>
    </article>
  );
}

function PassBar({ label, passed, total, tone }: { label: string; passed: number; total: number; tone: "before" | "after" }) {
  const ratio = total === 0 ? 0 : (passed / total) * 100;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between font-mono text-[12px]">
        <span className="uppercase text-subtle">{label}</span>
        <span className={tone === "after" ? "text-ok" : "text-fg-2"}>{passed}/{total}</span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-[2px] bg-line-2" role="img" aria-label={`${label}: ${passed} of ${total} passed`}>
        <div className={cn("absolute inset-y-0 left-0", tone === "after" ? "bg-ok" : "bg-danger")} style={{ width: `${ratio}%` }} />
      </div>
    </div>
  );
}

function DiffPanel({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <div className="overflow-hidden rounded-[4px] border border-line-2 bg-bg">
      <div className="flex h-9 items-center border-b border-line px-3 font-mono text-[11px] uppercase text-subtle">Patch</div>
      <pre className="overflow-x-auto py-3 font-mono text-[13px] leading-[1.65]"><code className="block min-w-max">
        {lines.map((l, i) => {
          const add = l.startsWith("+") && !l.startsWith("+++");
          const del = l.startsWith("-") && !l.startsWith("---");
          const meta = l.startsWith("---") || l.startsWith("+++") || l.startsWith("@@");
          return (
            <span
              key={i}
              className={cn(
                "block whitespace-pre px-3",
                add && "bg-ok/10 text-ok",
                del && "bg-danger/10 text-danger",
                meta && "text-subtle",
                !add && !del && !meta && "text-fg-2",
              )}
            >{l || " "}</span>
          );
        })}
      </code></pre>
    </div>
  );
}

function FixPanel({ fix, n }: { fix: Remediation; n: number }) {
  const title = sampleFindings.find((f) => f.id === fix.findingId)?.title ?? fix.findingId;
  const v = fix.verification;
  return (
    <Frame as="article" className="p-5 sm:p-8">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] uppercase text-subtle">
        <span className="text-fg">Fix {String(n).padStart(2, "0")}</span>
        <span aria-hidden>/</span>
        <span>{KIND_LABEL[fix.kind]}</span>
        <span aria-hidden>/</span>
        <span>for {fix.findingId}</span>
        <span className="inline-flex items-center gap-1.5 text-ok sm:ml-auto"><span aria-hidden className="size-1.5 rounded-full bg-ok" />{v.status.replace(/_/g, " ")}</span>
      </div>
      <h3 className="t-h3 mt-5 max-w-[34ch] text-balance text-fg">{fix.summary}</h3>
      <p className="t-small mt-2 text-subtle">{title}</p>
      <p className="t-body mt-4 max-w-[68ch] text-muted">{fix.rationale}</p>
      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-10">
        <DiffPanel patch={fix.patch} />
        <div className="space-y-5 self-start border-t border-line pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <PassBar label="Before" passed={v.before.passed} total={v.before.total} tone="before" />
          <PassBar label="After" passed={v.after.passed} total={v.after.total} tone="after" />
          <p className="font-mono text-[12px] text-muted">Regressions: <span className="text-fg">{v.regressions}</span></p>
        </div>
      </div>
    </Frame>
  );
}

function PricingNote() {
  return (
    <div className="grid border border-line-2 sm:grid-cols-2 sm:divide-x sm:divide-line-2">
      <div className="border-b border-line-2 p-6 sm:border-b-0 sm:p-8">
        <p className="t-eyebrow text-subtle">Fixed</p>
        <p className="t-h1 mt-5">{FIXED}</p>
        <p className="t-body mt-3 max-w-[40ch] text-muted">One flat price for the Trace Audit, however many findings turn up.</p>
      </div>
      <div className="p-6 sm:p-8">
        <p className="t-eyebrow text-subtle">Per confirmed finding</p>
        <p className="t-h1 mt-5">
          {confirmedCount} × {PER} = <span className="text-muted">{PER_TOTAL}</span>
        </p>
        <p className="t-body mt-3 max-w-[44ch] text-muted">Capped at {CAP}. You are only charged for findings we confirm; this report has {confirmedCount}. Zero confirmed means $0.</p>
      </div>
    </div>
  );
}

export function SampleReport() {
  const stats: [string, string][] = [
    ["Turns audited", String(sampleMeta.traceTurns)],
    ["Claims checked", String(sampleMeta.claimsChecked)],
    ["Confirmed", String(confirmedCount)],
    ["Validated fixes", String(sampleRemediations.length)],
  ];
  return (
    <PageShell>
      <header>
        <Eyebrow>{sampleMeta.generatedLabel} · fictional agent</Eyebrow>
        <h1 className="t-h1 mt-6 max-w-[18ch] text-balance">
          {sampleMeta.package}: <span className="text-muted">{sampleMeta.agent}</span>
        </h1>
        <p className="t-lead mt-6 max-w-[68ch]">{sampleReport.summary}</p>
        <dl className="mt-12 grid grid-cols-2 border border-line-2 lg:grid-cols-4">
          {stats.map(([k, v], i) => (
            <div key={k} className={cn("p-5 sm:p-6", i % 2 === 1 && "border-l border-line-2", i > 0 && "lg:border-l", i > 1 && "border-t border-line-2 lg:border-t-0")}>
              <dt className="sr-only">{k}</dt>
              <dd><Stat label={k} value={v} /></dd>
            </div>
          ))}
        </dl>
        <div className="mt-6">
          <a
            href="/sample/suite.json"
            download="sample-suite.json"
            className="inline-flex h-10 items-center gap-2 rounded-[4px] border border-line-3 px-4 text-[15px] font-medium text-fg transition-colors duration-150 hover:border-[#5a5e66] hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Download sample suite JSON <span aria-hidden>↓</span>
          </a>
        </div>
      </header>

      <section aria-labelledby="findings-h" className="mt-24 sm:mt-32">
        <SectionHead id="findings-h" index="01" label="Findings" title="What the audit found" lead="Each confirmed finding was re-run three times against the frozen scenario." />
        <div>
          {sampleFindings.map((f, i) => <FindingRow key={f.id} finding={f} index={i} />)}
        </div>
      </section>

      <section aria-labelledby="fixes-h" className="mt-24 sm:mt-32">
        <SectionHead id="fixes-h" index="02" label="Validated fixes" title="We do not just find problems. We prove the fix works." lead="Each fix is re-checked against the frozen scenarios and the rest of the suite for regressions." />
        <div className="space-y-6">
          {sampleRemediations.map((r, i) => <FixPanel key={r.findingId} fix={r} n={i + 1} />)}
        </div>
      </section>

      <section aria-labelledby="pricing-h" className="mt-24 sm:mt-32">
        <SectionHead id="pricing-h" index="03" label="Pricing" title="Two ways to pay. You choose." />
        <PricingNote />
      </section>

      <section className="mt-24 border-t border-line-2 pt-12 sm:mt-32">
        <h2 className="t-h2 max-w-[20ch] text-balance">Want this for your agent? <span className="text-muted">Send a trace or an endpoint.</span></h2>
        <p className="t-lead mt-4 max-w-[68ch]">You get a report like this one, with evidence and fixes you can verify.</p>
        <div className="mt-8"><Button href="/start" size="lg">Get your own eval <NudgeArrow /></Button></div>
      </section>
    </PageShell>
  );
}
