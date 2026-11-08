import type { Metadata } from "next";
import { PageShell } from "@/components/ui";
import { DemoPlayer } from "@/components/demo/DemoPlayer";
import type { DemoRun } from "@/components/demo/demo-run-types";
import { pct, recordedDate, str, usd } from "@/components/demo/format";
import raw from "../../../../../data/demo/real-run.json";

export const metadata: Metadata = {
  title: "Watch a real eval run",
  description:
    "A replay of a real recorded sandbox evaluation: a frontier support agent, a simulated customer, tool calls against a real Postgres branch, graded on database state.",
};

const run = raw as unknown as DemoRun;

function Summary({ run }: { run: DemoRun }) {
  const s = run.summary;
  const items: Array<[string, string]> = [
    ["pass@1", `${pct(s?.passAt1)} (${pct(s?.passAt1Ci95?.[0])}–${pct(s?.passAt1Ci95?.[1])} CI)`],
    ["pass^k", pct(s?.passHatK)],
    ["Scenarios · trials", `${s?.scenarios ?? run.scenarios.length} · ${s?.trials ?? "?"}`],
    ["Total cost", usd(s?.totalCostUsd)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-5 border-t border-line pt-5">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="t-eyebrow text-subtle">{k}</dt>
          <dd className="t-data mt-1.5 break-words text-[15px] text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function DemoPage() {
  const hasData = Array.isArray(run.scenarios) && run.scenarios.length > 0;
  return (
    <PageShell active="/demo">
      <header className="mb-10 grid gap-x-12 gap-y-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-end">
       <div>
        <p className="t-eyebrow mb-4 flex items-center gap-2 text-muted"><span className="eyebrow-mark" aria-hidden />Live replay</p>
        <h1 className="t-h1 text-balance">Watch a real eval run</h1>
        <p className="t-lead mt-4 max-w-[60ch] text-[16px]">
          A frontier agent plays customer support for {str(run.env?.name) || "a company"}. A simulated customer pushes on it, its tool calls hit a real Postgres branch,
          and we grade the resulting database state, not the chat.
        </p>
        <p className="t-data mt-5 text-subtle">
          Recorded live on {recordedDate(run.recordedAt)} · {str(run.agent?.model) || "unknown model"} · real model output, replayed
        </p>
       </div>
        {hasData ? <Summary run={run} /> : null}
      </header>
      {hasData ? (
        <DemoPlayer run={run} />
      ) : (
        <p className="text-muted">No recorded run is available yet.</p>
      )}
    </PageShell>
  );
}
