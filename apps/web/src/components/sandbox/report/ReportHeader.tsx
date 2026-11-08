import { Chip, Eyebrow, StatusChip } from "@/components/ui";
import { connectModeInfo, type SandboxRunReport } from "../contract";
import { formatDate } from "./format";
import { CostLine } from "./RunStatusPanels";

export function ReportHeader({ report }: { report: SandboxRunReport }) {
  return (
    <header className="min-w-0">
      <Eyebrow>Sandbox report</Eyebrow>
      <h1 className="t-h1 mt-4 break-words text-fg">{report.name}</h1>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted">
        {report.sample && <Chip tone="warn">Sample</Chip>}
        <StatusChip status={report.status} />
        <span>{connectModeInfo(report.mode).label}</span>
        <span className="font-mono tabular-nums">k = {report.k} trials</span>
        <time dateTime={report.createdAt} className="font-mono tabular-nums">{formatDate(report.createdAt)}</time>
        <span className="break-all font-mono text-[11px] text-subtle">{report.runId}</span>
      </div>
      <CostLine report={report} />
      {report.sample && (
        <div role="note" className="mt-6 rounded-[4px] border border-warn/40 bg-warn/5 px-4 py-3 text-[14px] text-fg-2">
          <strong className="font-medium text-warn">Sample report</strong> — fixture data shown while the sandbox engine is being built. These are not results from your agent.
        </div>
      )}
    </header>
  );
}
