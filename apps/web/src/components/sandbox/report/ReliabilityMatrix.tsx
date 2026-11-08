import { CATEGORY_LABELS, CATEGORY_ORDER, type SandboxRunReport } from "../contract";
import { pct, reliabilityMatrix } from "../stats";

/** Opacity steps by pass rate; the number is always shown too. */
function shade(rate: number): string {
  if (rate >= 1) return "bg-ok/25";
  if (rate >= 0.8) return "bg-ok/10";
  if (rate >= 0.5) return "bg-warn/20";
  return "bg-danger/25";
}

export function ReliabilityMatrix({ report }: { report: SandboxRunReport }) {
  const cells = reliabilityMatrix(report.scenarios, report.results);
  const cats = CATEGORY_ORDER.filter((c) => cells.some((x) => x.category === c));
  const rowIds = report.workflows.map((w) => w.id).filter((id) => cells.some((x) => x.workflowId === id));
  const nameOf = (id: string) => report.workflows.find((w) => w.id === id)?.name ?? id;
  const get = (w: string, c: string) => cells.find((x) => x.workflowId === w && x.category === c);
  return (
    <section aria-labelledby="matrix-h" className="mt-12 min-w-0">
      <h2 id="matrix-h" className="t-eyebrow mb-2 text-muted">Reliability matrix</h2>
      <p className="mb-4 text-[13px] text-muted">Trials passed / run, by workflow and scenario category. Shading tracks pass rate; the count is the source of truth.</p>
      <div className="max-w-full overflow-x-auto rounded-[4px] border border-line-2">
        <table className="w-full min-w-[520px] border-collapse text-[13px]">
          <caption className="sr-only">Passed trials over total trials per workflow and category</caption>
          <thead>
            <tr className="border-b border-line-2">
              <th scope="col" className="px-3 py-2 text-left font-mono text-[11px] font-normal uppercase text-subtle">Workflow</th>
              {cats.map((c) => (
                <th key={c} scope="col" className="px-3 py-2 text-center font-mono text-[11px] font-normal uppercase text-subtle">{CATEGORY_LABELS[c]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowIds.map((w) => (
              <tr key={w} className="border-b border-line last:border-b-0">
                <th scope="row" className="px-3 py-2 text-left font-normal text-fg-2">{nameOf(w)}</th>
                {cats.map((c) => {
                  const cell = get(w, c);
                  return (
                    <td key={c} className={`px-3 py-2 text-center font-mono tabular-nums ${cell ? shade(cell.passed / Math.max(cell.total, 1)) : ""}`}>
                      {cell ? (
                        <span title={pct(cell.passed / Math.max(cell.total, 1))}>{cell.passed}/{cell.total}</span>
                      ) : (
                        <span className="text-subtle" aria-label="no scenarios">–</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
