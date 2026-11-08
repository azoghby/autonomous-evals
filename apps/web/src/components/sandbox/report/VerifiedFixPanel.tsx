import { Chip, EmptyState } from "@/components/ui";
import type { SandboxRunReport } from "../contract";

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="max-w-full overflow-x-auto rounded-[4px] border border-line-2 bg-bg-raised p-4 font-mono text-[12px] leading-[1.6]">
      <code>
        {diff.split("\n").map((line, i) => (
          <span key={i} className={`block ${line.startsWith("+") ? "text-ok" : line.startsWith("-") ? "text-danger" : "text-fg-2"}`}>{line || " "}</span>
        ))}
      </code>
    </pre>
  );
}

export function VerifiedFixPanel({ report }: { report: SandboxRunReport }) {
  const fix = report.verifiedFix;
  return (
    <section aria-labelledby="fix-h" className="mt-12 min-w-0">
      <h2 id="fix-h" className="t-eyebrow mb-4 text-muted">Verified fix</h2>
      {!fix ? (
        <EmptyState title="No verified fix yet" description="When a failure cluster has a patch that passes on re-run without regressions, it appears here." />
      ) : (
        <div className="min-w-0 space-y-4">
          <h3 className="break-words text-[18px] text-fg">{fix.title}</h3>
          <p className="text-[14px] text-fg-2">{fix.summary}</p>
          <div className="flex flex-wrap items-center gap-3 font-mono text-[14px] tabular-nums">
            <span className="text-danger">{fix.before.passed}/{fix.before.total}</span>
            <span aria-label="to" className="text-subtle">→</span>
            <span className="text-ok">{fix.after.passed}/{fix.after.total}</span>
            <Chip tone="muted">{fix.controlScenarios} control scenarios</Chip>
            <Chip tone={fix.regressions === 0 ? "ok" : "danger"}>{fix.regressions} regressions</Chip>
          </div>
          <DiffView diff={fix.diff} />
          {fix.prUrl && /^https?:\/\//i.test(fix.prUrl) && (
            <a href={fix.prUrl} target="_blank" rel="noopener noreferrer" className="inline-block break-all text-[13px] text-accent-text underline-offset-4 hover:underline">
              View pull request
            </a>
          )}
        </div>
      )}
    </section>
  );
}
