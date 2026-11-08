"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { cn } from "@/components/ui";
import { sortMatrixRows, type AgentMatrix, type MatrixCell, type MatrixSortKey } from "@/server/leaderboard-matrix";

const pct = (r: number): string => `${Math.round(r * 100)}%`;
const TONE_TEXT = (r: number) => (r >= 0.85 ? "text-ok" : r >= 0.6 ? "text-warn" : "text-danger");
const TONE_BAR = (r: number) => (r >= 0.85 ? "bg-ok" : r >= 0.6 ? "bg-warn" : "bg-danger");

function SortButton({ label, active, dir, onClick, align = "left" }: { label: string; active: boolean; dir: "asc" | "desc"; onClick: () => void; align?: "left" | "right" }) {
  return (
    <button type="button" onClick={onClick}
      className={cn("group inline-flex items-center gap-1 rounded-[2px] font-mono text-[11px] uppercase outline-none transition-colors duration-150 hover:text-fg focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-accent",
        active ? "text-fg" : "text-subtle", align === "right" && "flex-row-reverse")}>
      <span>{label}</span>
      <span aria-hidden className={cn("w-2 text-[10px] transition-opacity duration-150", active ? "opacity-100" : "opacity-0 group-hover:opacity-50")}>{dir === "asc" && active ? "↑" : "↓"}</span>
    </button>
  );
}

function Cell({ cell, model }: { cell: MatrixCell | undefined; model: string }) {
  if (!cell) return <span className="t-data text-subtle" aria-label={`Not run on ${model}`}>·</span>;
  return (
    <Link href={`/leaderboard/${cell.slug}`} className="group/cell inline-flex min-w-16 flex-col items-end gap-1.5 rounded-[2px] outline-none focus-visible:ring-1 focus-visible:ring-accent"
      aria-label={`${model}: ${pct(cell.passRate)} pass rate, rank ${cell.rank}${cell.criticalCount ? `, ${cell.criticalCount} critical` : ""}`}>
      <span className={cn("t-data text-[15px] underline-offset-4 group-hover/cell:underline", TONE_TEXT(cell.passRate))}>
        {pct(cell.passRate)}{cell.criticalCount > 0 && <span className="ml-1 text-[11px] text-danger" aria-hidden>!</span>}
      </span>
      <span aria-hidden className="relative block h-1 w-14 overflow-hidden rounded-[1px] bg-line-2">
        <span className={cn("absolute inset-y-0 left-0 block", TONE_BAR(cell.passRate))} style={{ width: `${Math.round(cell.passRate * 100)}%` }} />
      </span>
    </Link>
  );
}

/** One row per open-source agent, one column per model. Click a header to sort; every cell links to that run's page. */
export function AgentMatrixTable({ matrix }: { matrix: AgentMatrix }) {
  const [sort, setSort] = useState<{ key: MatrixSortKey; dir: "asc" | "desc" }>({ key: "mean", dir: "desc" });
  const rows = useMemo(() => sortMatrixRows(matrix.rows, sort.key, sort.dir), [matrix.rows, sort]);
  const toggle = (key: MatrixSortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  const ariaSort = (key: MatrixSortKey) => (sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none");
  const th = "px-4 py-3 align-bottom font-normal";

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse">
        <caption className="sr-only">Open-source agents by model: pass rate on the frozen suite. Column headers sort the table.</caption>
        <thead><tr>
          <th scope="col" aria-sort={ariaSort("name")} className={cn(th, "sticky left-0 z-10 bg-bg-raised text-left")}>
            <SortButton label="Agent" active={sort.key === "name"} dir={sort.dir} onClick={() => toggle("name")} />
          </th>
          {matrix.columns.map((c) => {
            const key = `model:${c.model}` as const;
            return (
              <th key={c.model} scope="col" aria-sort={ariaSort(key)} className={cn(th, "text-right")}>
                <SortButton label={c.label} active={sort.key === key} dir={sort.dir} onClick={() => toggle(key)} align="right" />
              </th>
            );
          })}
          <th scope="col" aria-sort={ariaSort("best")} className={cn(th, "border-l border-line text-right")}>
            <SortButton label="Best" active={sort.key === "best"} dir={sort.dir} onClick={() => toggle("best")} align="right" />
          </th>
          <th scope="col" aria-sort={ariaSort("mean")} className={cn(th, "text-right")}>
            <SortButton label="Mean" active={sort.key === "mean"} dir={sort.dir} onClick={() => toggle("mean")} align="right" />
          </th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className="group border-t border-line transition-colors duration-150 hover:bg-bg-hover">
              <th scope="row" className="sticky left-0 z-10 bg-bg-raised px-4 py-4 text-left font-normal transition-colors duration-150 group-hover:bg-bg-hover">
                <div className="flex items-baseline gap-3">
                  <span className="t-data w-5 shrink-0 text-subtle">{String(i + 1).padStart(2, "0")}</span>
                  <div className="min-w-0 max-w-[18rem]">
                    <div className="text-[15px] leading-snug text-fg">{r.name}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
                      <span>{r.vendor}</span>
                      {r.homepage && <a href={r.homepage} target="_blank" rel="noopener noreferrer" className="text-accent-text underline-offset-4 hover:underline focus-visible:underline">Source</a>}
                      {r.termsUrl && <a href={r.termsUrl} target="_blank" rel="noopener noreferrer" className="text-accent-text underline-offset-4 hover:underline focus-visible:underline">License</a>}
                    </div>
                  </div>
                </div>
              </th>
              {matrix.columns.map((c) => <td key={c.model} className="px-4 py-4 text-right"><Cell cell={r.cells[c.model]} model={c.label} /></td>)}
              <td className="t-data border-l border-line px-4 py-4 text-right text-fg">{pct(r.best)}</td>
              <td className="t-data px-4 py-4 text-right text-fg-2">{pct(r.mean)}<span className="ml-1 text-[11px] text-subtle">/{r.runs}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
