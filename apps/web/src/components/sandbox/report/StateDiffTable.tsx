import type { StateDiff } from "@ae/core/sandbox/spec";
import { compactJson } from "./format";

function Cell({ v }: { v: unknown }) {
  return <>{typeof v === "string" ? v : compactJson(v)}</>;
}

export function StateDiffTable({ diff }: { diff: StateDiff[] }) {
  if (diff.length === 0) return <p className="text-[13px] text-muted">No state changes.</p>;
  return (
    <div className="max-w-full overflow-x-auto rounded-[4px] border border-line-2">
      <table className="w-full min-w-[420px] border-collapse text-[13px]">
        <caption className="sr-only">Database state changes by table</caption>
        <thead>
          <tr className="border-b border-line-2 font-mono text-[11px] uppercase text-subtle">
            <th scope="col" className="px-3 py-2 text-left font-normal">Table</th>
            <th scope="col" className="px-3 py-2 text-right font-normal">Inserted</th>
            <th scope="col" className="px-3 py-2 text-right font-normal">Updated</th>
            <th scope="col" className="px-3 py-2 text-right font-normal">Deleted</th>
          </tr>
        </thead>
        {diff.map((d) => {
          const cols = Array.from(new Set(d.sample.flatMap((r) => Object.keys(r))));
          return (
            <tbody key={d.table} className="border-b border-line last:border-b-0">
              <tr>
                <th scope="row" className="px-3 py-2 text-left font-mono font-normal text-fg">{d.table}</th>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-ok">{d.inserted}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-warn">{d.updated}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-danger">{d.deleted}</td>
              </tr>
              {d.sample.length > 0 && (
                <tr>
                  <td colSpan={4} className="bg-bg-raised px-3 pb-3 pt-1">
                    <div className="max-w-full overflow-x-auto">
                      <table className="w-full border-collapse font-mono text-[12px]">
                        <caption className="sr-only">Sample rows for {d.table}</caption>
                        <thead>
                          <tr className="text-subtle">
                            {cols.map((c) => <th key={c} scope="col" className="whitespace-nowrap px-2 py-1 text-left font-normal">{c}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {d.sample.map((r, i) => (
                            <tr key={i} className="border-t border-line text-fg-2">
                              {cols.map((c) => <td key={c} className="whitespace-nowrap px-2 py-1"><Cell v={r[c]} /></td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
