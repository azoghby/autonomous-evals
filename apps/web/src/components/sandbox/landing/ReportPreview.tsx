import { Chip, Eyebrow, Frame } from "@/components/ui";

const FEATURES = [
  { t: "pass^k and pass^1", d: "How often the agent succeeds every time, not just once, each with a 95% Wilson confidence interval." },
  { t: "Utility vs attack success", d: "Whether it finishes real tasks, and whether it resists injection and policy attacks, side by side." },
  { t: "Reliability matrix", d: "Scenario by trial, so flaky behaviour is visible instead of averaged away." },
  { t: "Failure clusters", d: "Failures grouped by root cause, ranked by severity." },
  { t: "Per-trial replay", d: "Step through every tool call with a state diff of what changed in the world." },
  { t: "Verified fix", d: "A suggested patch, re-run against the failing scenarios to confirm it helps." },
];

const CELLS = ["pass", "pass", "fail", "pass", "pass", "pass", "fail", "fail", "pass", "pass", "pass", "pass"] as const;

export function ReportPreview() {
  return (
    <section aria-labelledby="sb-report" className="py-16 md:py-24">
      <div className="flex flex-col gap-5">
        <Eyebrow>The report</Eyebrow>
        <h2 id="sb-report" className="t-h2 max-w-[26ch] text-fg text-balance">
          Graded on what changed. <span className="text-muted">Not on what the agent said.</span>
        </h2>
      </div>
      <div className="mt-10 grid min-w-0 grid-cols-1 gap-10 lg:grid-cols-12 lg:gap-8">
        <dl className="grid min-w-0 grid-cols-1 border-t border-line-2 sm:grid-cols-2 lg:col-span-7">
          {FEATURES.map((f) => (
            <div key={f.t} className="min-w-0 border-b border-line-2 py-5 sm:pr-6">
              <dt className="t-h4 text-fg">{f.t}</dt>
              <dd className="t-small mt-2 break-words text-fg-2">{f.d}</dd>
            </div>
          ))}
        </dl>
        <div className="min-w-0 lg:col-span-5">
          <Frame className="flex flex-col gap-5 p-5">
            <div className="flex items-center justify-between gap-3">
              <span className="t-eyebrow text-muted">Reliability matrix</span>
              <Chip tone="warn">Sample</Chip>
            </div>
            <div className="grid grid-cols-4 gap-px bg-line-2" role="img" aria-label="Illustrative reliability matrix, sample data only">
              {CELLS.map((c, i) => (
                <div key={i} className={`h-8 ${c === "pass" ? "bg-bg-raised" : "bg-danger/60"}`} />
              ))}
            </div>
            <p className="t-small text-muted">Illustrative layout only. The numbers in a real report come from your own runs.</p>
          </Frame>
        </div>
      </div>
    </section>
  );
}
