import { PLANS, PLAN_ORDER } from "@ae/core/pricing/plans";
import { COMPARISON_ROWS, type Cell } from "./comparison";

function Soon() {
  return <sup className="pr-soon" title="Coming soon"><span aria-hidden>†</span><span className="sr-only"> (coming soon)</span></sup>;
}

function CellView({ cell }: { cell: Cell }) {
  if (cell === true) return <><span aria-hidden className="text-accent-text">●</span><span className="sr-only">Included</span></>;
  if (cell === false) return <><span aria-hidden className="text-subtle">–</span><span className="sr-only">Not included</span></>;
  if (typeof cell === "string") return <>{cell}</>;
  return <>{cell.text}<Soon /></>;
}

export function ComparisonTable() {
  return (
    <div className="pr-table-wrap" tabIndex={0} role="region" aria-label="Plan comparison (scrollable)">
      <table className="pr-table">
        <caption className="sr-only">Compare Developer, Pro, Scale and Enterprise plans</caption>
        <thead>
          <tr>
            <th scope="col"><span className="sr-only">Feature</span></th>
            {PLAN_ORDER.map((id) => (
              <th key={id} scope="col" className={PLANS[id].highlighted ? "pr-col-hl" : undefined}>{PLANS[id].name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPARISON_ROWS.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}{r.soon && <Soon />}</th>
              {PLAN_ORDER.map((id) => (
                <td key={id} className={PLANS[id].highlighted ? "pr-col-hl" : undefined}><CellView cell={r.cells[id]} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
