import { KeyValue } from "@/components/ui";
import type { SandboxRunReport } from "../contract";

export function VersionsPanel({ report }: { report: SandboxRunReport }) {
  const v = report.versions;
  const rows: Array<[string, string]> = [
    ["Spec", String(v.spec)], ["Suite hash", v.suiteHash], ["Env hash", v.envHash],
    ["Simulator model", v.simulatorModel], ["Judge model", v.judgeModel], ["Runtime", v.runtime],
  ];
  return (
    <section aria-labelledby="versions-h" className="mt-12 min-w-0">
      <h2 id="versions-h" className="t-eyebrow mb-4 text-muted">Versions</h2>
      <dl className="border-y border-line-2">
        {rows.map(([k, val]) => <KeyValue key={k} label={k}><span className="break-all font-mono">{val}</span></KeyValue>)}
      </dl>
      <p className="mt-3 text-[13px] text-muted">Scores produced under different versions are not comparable. Re-run on the same versions to measure change.</p>
    </section>
  );
}
