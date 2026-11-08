import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentCustomer } from "@/server/session";
import { getSandboxService } from "@/server/sandbox-service";
import { SandboxShell } from "@/components/sandbox/SandboxShell";
import { SAMPLE_RUN_ID } from "@/components/sandbox/contract";
import { ComparePicker, type PickerRun } from "@/components/sandbox/compare/ComparePicker";
import { CompareView } from "@/components/sandbox/compare/CompareView";
import { Eyebrow } from "@/components/ui";
import { compareReports, parseView } from "@/lib/run-compare";

export const metadata: Metadata = { title: "Compare runs · Standard Evals" };
export const dynamic = "force-dynamic";

const RUN_ID = /^(sample|run_[0-9a-f-]{36})$/;
type Search = { base?: string | string[]; other?: string | string[]; view?: string | string[] };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ComparePage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const base = one(sp.base), other = one(sp.other), view = parseView(one(sp.view));
  const viewer = await getCurrentCustomer();
  if (!viewer) {
    const qs = new URLSearchParams(Object.entries({ base, other }).filter((e): e is [string, string] => Boolean(e[1]))).toString();
    redirect(`/signin?next=${encodeURIComponent(`/sandbox/compare${qs ? `?${qs}` : ""}`)}`);
  }
  if ((base && !RUN_ID.test(base)) || (other && !RUN_ID.test(other))) notFound();

  const service = getSandboxService();
  const listed = await service.listRuns(viewer.id, 50);
  const sample = await service.getRunReport(viewer.id, SAMPLE_RUN_ID);
  const runs: PickerRun[] = [
    ...listed.filter((r) => r.status === "complete" || r.passAt1 !== null)
      .map((r) => ({ runId: r.runId, name: r.name, createdAt: r.createdAt, k: r.k, passHatK: r.passHatK })),
    ...(sample ? [{ runId: SAMPLE_RUN_ID, name: /sample/i.test(sample.name) ? sample.name : `${sample.name} (sample)`, createdAt: sample.createdAt, k: sample.k, passHatK: null }] : []),
  ];

  const [baseReport, otherReport] = base && other
    ? await Promise.all([service.getRunReport(viewer.id, base), service.getRunReport(viewer.id, other)])
    : [null, null];
  if (base && other && (!baseReport || !otherReport)) notFound();

  const defaults = { base: base ?? runs[1]?.runId ?? runs[0]?.runId, other: other ?? runs[0]?.runId };
  const cmp = baseReport && otherReport ? compareReports(baseReport, otherReport) : null;

  return (
    <SandboxShell active="/sandbox/compare">
      <div className="min-w-0 pb-24 pt-10">
        <header>
          <Eyebrow>Run comparison</Eyebrow>
          <h1 className="t-h1 mt-4 text-fg">Did the change help?</h1>
          <p className="t-lead mt-3 max-w-[62ch]">
            Put two runs side by side: reliability deltas, every scenario that regressed or got fixed, and checks that started failing.
            Shareable by URL, computed from the stored trial results.
          </p>
        </header>
        <div className="mt-8"><ComparePicker runs={runs} base={defaults.base} other={defaults.other} /></div>
        {cmp ? (
          <div className="mt-10"><CompareView cmp={cmp} view={view} query={{ base: base!, other: other! }} /></div>
        ) : (
          <div className="rc-empty mt-10">
            {listed.length < 2 ? (
              <>You need two finished runs to compare. Re-run an eval after changing your prompt or model, or <Link className="rc-link" href={`/sandbox/compare?base=${SAMPLE_RUN_ID}&other=${SAMPLE_RUN_ID}`}>open the sample</Link> to see the layout. <Link className="rc-link" href="/sandbox/new">Start a sandbox eval</Link>.</>
            ) : (
              <>Pick a base run and the run you want to measure against it.</>
            )}
          </div>
        )}
      </div>
    </SandboxShell>
  );
}
