import { Chip } from "@/components/ui";
import type { SandboxRunReport } from "../contract";
import { ATTRIBUTION_LABEL, SEVERITY_TONE, findClause, isAgentFault } from "./format";

export function FailureClusters({ report }: { report: SandboxRunReport }) {
  const title = (id: string) => report.scenarios.find((s) => s.id === id)?.title ?? id;
  return (
    <section aria-labelledby="clusters-h" className="mt-12 min-w-0">
      <h2 id="clusters-h" className="t-eyebrow mb-4 text-muted">Failure clusters</h2>
      {report.clusters.length === 0 ? (
        <p className="border-t border-line-2 py-8 text-[14px] text-muted">No failures were clustered in this run.</p>
      ) : (
        <ul className="divide-y divide-line-2 border-y border-line-2">
          {report.clusters.map((c) => {
            const clause = findClause(report.policies, c.policyRef);
            const agent = isAgentFault(c.attribution);
            return (
              <li key={c.id} className="min-w-0 py-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={SEVERITY_TONE[c.severity]}>{c.severity}</Chip>
                  <Chip tone={agent ? "neutral" : "muted"}>{ATTRIBUTION_LABEL[c.attribution] ?? c.attribution}</Chip>
                  {!agent && <span className="text-[12px] text-muted">Not counted against your agent</span>}
                  <span className="ml-auto font-mono text-[12px] text-subtle tabular-nums">{c.trialCount} failing trial{c.trialCount === 1 ? "" : "s"}</span>
                </div>
                <h3 className="mt-3 break-words text-[16px] text-fg">{c.title}</h3>
                <p className="mt-1 text-[14px] text-fg-2">{c.rootCause}</p>
                {clause && (
                  <blockquote className="mt-3 border-l-2 border-line-3 pl-3 text-[13px] text-muted">
                    <span className="font-mono text-[11px] uppercase text-subtle">Policy {clause.id}</span> · {clause.text}
                  </blockquote>
                )}
                <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                  {c.scenarioIds.map((id) => (
                    <li key={id}>
                      <a href={`#replay-${id}`} className="text-[13px] text-accent-text underline-offset-4 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-accent">
                        {title(id)} - replay
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
