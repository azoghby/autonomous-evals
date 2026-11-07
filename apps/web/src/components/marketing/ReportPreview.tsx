import Link from "next/link";
import { Frame, NudgeArrow, Reveal, Section, SectionHeader, StatusChip } from "../ui";

const COUNTS = [
  ["Critical", 0, "bg-danger"],
  ["High", 2, "bg-danger"],
  ["Medium", 1, "bg-warn"],
  ["Low", 0, "bg-subtle"],
] as const;

const FINDINGS = [
  { id: "F-1", sev: "high", dot: "bg-danger", title: "Agent books a meeting without checking calendar conflicts", open: false },
  { id: "F-2", sev: "high", dot: "bg-danger", title: "Refund claimed as issued without calling the refund tool", open: true },
  { id: "F-3", sev: "medium", dot: "bg-warn", title: "Ignores the stated timezone when proposing times", open: false },
] as const;

export function ReportPreview() {
  return (
    <Section id="report" labelledBy="report-h">
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
        <Frame as="article" aria-label="Sample delivered report" className="bg-bg-raised">
          <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line-2 px-4 py-4 sm:px-6">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="font-mono text-[11px] uppercase text-subtle">Workflow Eval</span>
              <span className="t-h3 text-fg">support-bot v3</span>
            </div>
            <StatusChip status="delivered" />
          </header>
          <dl className="grid grid-cols-2 border-b border-line-2 sm:grid-cols-4">
            {COUNTS.map(([label, n, dot], i) => (
              <div key={label} className={`flex items-center justify-between gap-3 px-4 py-4 sm:px-6 ${i % 2 === 1 ? "border-l border-line-2" : ""} ${i >= 2 ? "border-t border-line-2 sm:border-t-0" : ""} ${i > 0 ? "sm:border-l sm:border-line-2" : ""}`}>
                <dt className="inline-flex items-center gap-2 font-mono text-[11px] uppercase text-subtle"><i aria-hidden className={`size-1.5 ${dot}`} />{label}</dt>
                <dd className="t-data text-fg">{n}</dd>
              </div>
            ))}
          </dl>
          <ul>
            {FINDINGS.map((f) => (
              <li key={f.id} className="border-b border-line-2 last:border-b-0">
                <div className="flex items-start gap-3 px-4 py-4 sm:px-6">
                  <i aria-hidden className={`mt-[7px] size-2 shrink-0 ${f.dot}`} />
                  <span className="t-data mt-px w-8 shrink-0 text-subtle">{f.id}</span>
                  <span className="t-body min-w-0 flex-1 text-fg">{f.title}</span>
                  <span className="hidden font-mono text-[11px] uppercase text-subtle sm:inline">{f.sev}</span>
                </div>
                {f.open && (
                  <div className="grid gap-6 border-t border-dashed border-line-2 bg-bg px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_16rem] lg:pl-[4.5rem]">
                    <figure className="min-w-0">
                      <figcaption className="mb-2 font-mono text-[11px] uppercase text-subtle">Evidence · trace.json, turn 7</figcaption>
                      <pre className="t-data overflow-x-auto rounded-[4px] border border-line-2 bg-bg-raised p-4 text-fg-2"><code>{`{ "role": "assistant",
  "content": "Done, your refund of $42.00 has been issued.",
  `}<mark className="bg-accent-soft text-accent-text">{`"tool_calls": []`}</mark>{` }`}</code></pre>
                    </figure>
                    <div className="flex flex-col gap-3 text-[13px]">
                      <span className="inline-flex items-center gap-2 text-ok"><i aria-hidden className="size-1.5 rounded-full bg-ok" />Reproduced 3/3</span>
                      <span className="text-muted">No call to <code className="font-mono text-fg-2">issue_refund</code> appears anywhere in the trace.</span>
                      <span className="font-mono text-[11px] uppercase text-subtle">Re-run: finding F-2</span>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Frame>
      </Reveal>
    </Section>
  );
}
