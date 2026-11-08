import type { Metadata } from "next";
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
import { VersionsPanel } from "@/components/sandbox/report/VersionsPanel";

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

  return (
    <SandboxShell active={runId === "sample" ? "/sandbox/runs/sample" : undefined}>
    <div className="min-w-0 pb-24 pt-10">
      <ReportHeader report={report} />
      <Headline report={report} />
      <ReliabilityMatrix report={report} />
      <FailureClusters report={report} />
      <section aria-labelledby="replay-h" className="mt-12 min-w-0">
        <h2 id="replay-h" className="t-eyebrow mb-4 text-muted">Trial replay</h2>
        <TrialReplay scenarios={report.scenarios} results={report.results} policies={report.policies} media={report.media} />
      </section>
      <VersionsPanel report={report} />
      <VerifiedFixPanel report={report} />
    </div>
    </SandboxShell>
  );
}
