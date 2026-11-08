import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentCustomer } from "@/server/session";
import { getSandboxService } from "@/server/sandbox-service";
import { SandboxShell } from "@/components/sandbox/SandboxShell";
import { FailureClusters } from "@/components/sandbox/report/FailureClusters";
import { Headline } from "@/components/sandbox/report/Headline";
import { ReliabilityMatrix } from "@/components/sandbox/report/ReliabilityMatrix";
import { ReportHeader } from "@/components/sandbox/report/ReportHeader";
import { TrialReplay } from "@/components/sandbox/report/TrialReplay";
import { VerifiedFixPanel } from "@/components/sandbox/report/VerifiedFixPanel";
import { RunErrorNotice, RunProgress } from "@/components/sandbox/report/RunStatusPanels";
import { VersionsPanel } from "@/components/sandbox/report/VersionsPanel";
import { EvalCopilot, EvalCopilotLayout } from "@/components/eval-chat/EvalCopilot";

export const metadata: Metadata = { title: "Sandbox report · Standard Evals" };
export const dynamic = "force-dynamic";

const RUN_ID = /^(sample|run_[0-9a-f-]{36})$/;

export default async function SandboxRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const viewer = await getCurrentCustomer();
  if (!viewer) redirect(`/signin?next=/sandbox/runs/${encodeURIComponent(runId)}`);
  if (!RUN_ID.test(runId)) notFound();
  const report = await getSandboxService().getRunReport(viewer.id, runId);
  if (!report) notFound();

  const hasResults = report.results.length > 0;

  return (
    <SandboxShell active={runId === "sample" ? "/sandbox/runs/sample" : undefined}>
    <EvalCopilotLayout copilot={<EvalCopilot evalRef={{ kind: "sandbox_run", id: runId }} title={report.name} />}>
    <div className="min-w-0 pb-24 pt-10">
      <ReportHeader report={report} />
      {hasResults && (
        <p className="mt-4 text-[13px]">
          <Link className="rc-link" href={`/sandbox/compare?other=${encodeURIComponent(runId)}`}>Compare with another run →</Link>
        </p>
      )}
      <RunProgress report={report} />
      <RunErrorNotice report={report} />
      {hasResults && <Headline report={report} />}
      {hasResults && <ReliabilityMatrix report={report} />}
      {hasResults && <FailureClusters report={report} />}
      {hasResults && (
        <section aria-labelledby="replay-h" className="mt-12 min-w-0">
          <h2 id="replay-h" className="t-eyebrow mb-4 text-muted">Trial replay</h2>
          <TrialReplay scenarios={report.scenarios} results={report.results} policies={report.policies} media={report.media} />
        </section>
      )}
      <VersionsPanel report={report} />
      <VerifiedFixPanel report={report} />
    </div>
    </EvalCopilotLayout>
    </SandboxShell>
  );
}
