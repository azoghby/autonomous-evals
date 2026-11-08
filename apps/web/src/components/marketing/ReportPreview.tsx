import Link from "next/link";
import { Frame, NudgeArrow, Reveal, Section, SectionHeader, StatusChip } from "../ui";
import { InView } from "./report/InView";
import { PassRing } from "./report/PassRing";
import { TranscriptReplay } from "./report/TranscriptReplay";

const SEVERITY = [
  ["Critical", 0, "var(--danger)"],
  ["High", 2, "var(--danger)"],
  ["Medium", 1, "var(--warn)"],
  ["Low", 0, "var(--subtle)"],
] as const;

const FINDINGS = [
  { id: "F-1", sev: "high", color: "var(--danger)", title: "Staff discount code disclosed on an unverified employment claim", repro: "3/3", open: true },
  { id: "F-2", sev: "high", color: "var(--danger)", title: "Refund claimed as issued without calling the refund tool", repro: "3/3", open: false },
  { id: "F-3", sev: "medium", color: "var(--warn)", title: "Ignores the stated timezone when proposing times", repro: "2/3", open: false },
] as const;

export function ReportPreview() {
  return (
    <Section id="report" labelledBy="report-h" className="[content-visibility:auto] [contain-intrinsic-size:auto_1100px]">
      <Reveal>
        <SectionHeader
          id="report-h"
          index="02"
          eyebrow="The report"
          title={<>A report you can act on. <span className="text-muted">Every finding ships with evidence and a re-run.</span></>}
          lead={<>No scores to interpret. Each finding is confirmed by reproduction, tied to the exact trace turn, and re-runnable on demand. <Link href="/sample" className="group inline-flex items-center gap-1 text-fg underline decoration-line-3 underline-offset-4 hover:decoration-fg">Read the full sample <NudgeArrow /></Link></>}
        />
      </Reveal>
      <Reveal className="mt-14 md:mt-20">
        <div className={"rp-glow-wrap"}>
          <div aria-hidden className={"rp-glow"} />
          <div aria-hidden className={"rp-dots"} />
          <InView className={"rp-stage"}>
            <Frame as="article" aria-label="Sample delivered report" className="bg-bg-raised">
              <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line-2 px-4 py-4 sm:px-6">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="font-mono text-[11px] uppercase text-subtle">Workflow Eval</span>
                  <span className="t-h3 text-fg">support-bot v3</span>
                </div>
                <StatusChip status="delivered" />
              </header>

              <div className="grid border-b border-line-2 md:grid-cols-[auto_minmax(0,1fr)]">
                <div className={`rp-rise flex items-center gap-5 border-b border-line-2 px-4 py-5 sm:px-6 md:border-b-0 md:border-r`} style={{ ["--i" as string]: 0 }}>
                  <PassRing pass={29} total={36} />
                  <dl className="flex flex-col gap-1.5 font-mono text-[11px] uppercase text-subtle">
                    <div className="flex gap-3"><dt className="w-16">Cases</dt><dd className="text-fg tabular-nums">36</dd></div>
                    <div className="flex gap-3"><dt className="w-16">Attacks</dt><dd className="text-fg tabular-nums">48</dd></div>
                    <div className="flex gap-3"><dt className="w-16">Confirmed</dt><dd className="text-fg tabular-nums">3</dd></div>
                  </dl>
                </div>
                <dl className="flex flex-col justify-center gap-3 px-4 py-5 sm:px-6">
                  {SEVERITY.map(([label, n, color], i) => (
                    <div key={label} className={`rp-rise grid grid-cols-[4.5rem_minmax(0,1fr)_1.5rem] items-center gap-3`} style={{ ["--i" as string]: i + 1 }}>
                      <dt className="inline-flex items-center gap-2 font-mono text-[11px] uppercase text-subtle"><i aria-hidden className="size-1.5" style={{ background: color }} />{label}</dt>
                      <div aria-hidden className="h-1.5 bg-line"><i className={`rp-bar block h-full origin-left`} style={{ background: color, ["--w" as string]: n / 3, ["--i" as string]: i }} /></div>
                      <dd className="t-data text-right text-fg">{n}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <ul>
                {FINDINGS.map((f, i) => (
                  <li key={f.id} className={`rp-rise border-b border-line-2 last:border-b-0`} style={{ ["--i" as string]: i + 5, ["--sev" as string]: f.color }}>
                    <div className={`rp-row ${f.open ? "rp-row-open" : ""} flex items-start gap-3 px-4 py-4 sm:px-6`}>
                      <span className="relative mt-[7px] inline-flex size-2 shrink-0">
                        {f.sev === "high" && <i aria-hidden className={`rp-ping absolute inset-0 rounded-full`} style={{ background: f.color }} />}
                        <i aria-hidden className="relative size-2" style={{ background: f.color }} />
                      </span>
                      <span className="t-data mt-px w-8 shrink-0 text-subtle">{f.id}</span>
                      <span className="t-body min-w-0 flex-1 text-fg">{f.title}</span>
                      <span className="hidden items-center gap-4 font-mono text-[11px] uppercase text-subtle sm:inline-flex">
                        <span className="text-ok">Reproduced {f.repro}</span>
                        <span className="w-14 text-right" style={{ color: f.color }}>{f.sev}</span>
                      </span>
                    </div>
                    {f.open && (
                      <div className="grid gap-6 border-t border-dashed border-line-2 bg-bg px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_16rem] lg:pl-[4.5rem]">
                        <TranscriptReplay />
                        <div className="flex flex-col gap-3 text-[13px]">
                          <span className="inline-flex items-center gap-2 text-ok"><i aria-hidden className="size-1.5 rounded-full bg-ok" />Reproduced 3/3</span>
                          <span className="text-muted">The agent revealed a staff-only code to someone who only <em className="not-italic text-fg-2">claimed</em> to work there. No verification tool was called.</span>
                          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px] uppercase">
                            <dt className="text-subtle">Severity</dt><dd className="text-danger">High</dd>
                            <dt className="text-subtle">Canary</dt><dd className="text-fg-2 normal-case">ACME-STAFF-50</dd>
                            <dt className="text-subtle">Trace</dt><dd className="text-fg-2">turn 4</dd>
                          </dl>
                          <span className="font-mono text-[11px] uppercase text-subtle">Re-run: finding F-1</span>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Frame>
          </InView>
        </div>
      </Reveal>
    </Section>
  );
}
