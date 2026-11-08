import type { DiffRow, StateDiffCard } from "@/lib/eval-chat/types";
import { cellText, changedKeys } from "../format";
import { ToolFrame } from "../ToolFrame";

const MARKER = { insert: "+", update: "~", delete: "-" } as const;
const TONE = { insert: "ok", update: "warn", delete: "danger" } as const;
const WORD = { insert: "Inserted", update: "Updated", delete: "Deleted" } as const;

function DiffEntry({ row }: { row: DiffRow }) {
  const changed = new Set(changedKeys(row.before, row.after));
  const keys = [...new Set([...Object.keys(row.before ?? {}), ...Object.keys(row.after ?? {})])];
  const shown = row.change === "update" ? keys.filter((k) => changed.has(k)) : keys;
  return (
    <div className="ec-diff">
      <div className="ec-diff-head">
        <span className="ec-diff-mark" data-tone={TONE[row.change]} aria-hidden="true">{MARKER[row.change]}</span>
        <span className="ec-mono">{row.table}</span>
        <span className="ec-dim ec-mono">{row.pk}</span>
        <span className="ec-sr">{WORD[row.change]}</span>
      </div>
      <div className="ec-scroll" tabIndex={0} role="region" aria-label={`${WORD[row.change]} ${row.table} ${row.pk}`}>
        <table className="ec-table">
          <thead><tr><th scope="col">Column</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
          <tbody>
            {shown.map((k) => {
              const isChanged = changed.has(k);
              return (
                <tr key={k} data-changed={isChanged ? "true" : "false"}>
                  <th scope="row" className="ec-mono">{k}</th>
                  <td className="ec-mono" data-side="before">{row.before && k in row.before ? cellText(row.before[k]) : "–"}</td>
                  <td className="ec-mono" data-side="after">{row.after && k in row.after ? cellText(row.after[k]) : "–"}</td>
                </tr>
              );
            })}
            {shown.length === 0 ? <tr><td colSpan={3} className="ec-dim">No column changes.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Reusable rows: one before -> after table per changed record. */
export function StateDiffRows({ rows }: { rows: readonly DiffRow[] }) {
  return <div className="ec-diffs">{rows.map((r, i) => <DiffEntry key={`${r.table}:${r.pk}:${i}`} row={r} />)}</div>;
}

export function StateDiff({ data }: { data: StateDiffCard }) {
  return (
    <ToolFrame title={`State changes, trial ${data.trial}`} stateLabel={`${data.rows.length} rows`}>
      {data.tables.length > 0 ? (
        <ul className="ec-chips" aria-label="Tables changed">
          {data.tables.map((t) => (
            <li key={t.table} className="ec-chip"><span className="ec-mono">{t.table}</span><span className="ec-dim">+{t.inserted} ~{t.updated} -{t.deleted}</span></li>
          ))}
        </ul>
      ) : null}
      {data.rows.length > 0 ? <StateDiffRows rows={data.rows} /> : <p className="ec-dim">The agent changed no data in this trial.</p>}
    </ToolFrame>
  );
}
