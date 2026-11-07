"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PRICE_CENTS, type JobState } from "@ae/core/contracts/index";
import { api, dollars, PACKAGE_LABEL, when } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import { normalizeFinding, type JobDetail, type ProgressItem, type ProgressResponse } from "@/lib/client/types";
import { Chip, ErrorBox, Glass, Loading, LinkBtn, PageTitle, StateChip } from "./ui";
import { Clarification } from "./job-clarification";
import { QuoteCard } from "./job-quote";
import { ProgressTimeline } from "./job-progress";
import { ReportView } from "./job-report";

const POLL_MS = 3000;
const POLLING_STATES: ReadonlySet<JobState> = new Set(["planning", "running", "investigating"]);

const EXPLAIN: Partial<Record<JobState, { title: string; body: string }>> = {
  failed: { title: "This job failed", body: "Something went wrong on our side. A founder has been alerted and will review it. You have not been charged for failed work without a refund path; reply to your confirmation email if you need help." },
  paused_budget: { title: "Paused: budget limit reached", body: "This job hit its compute budget cap and was paused so costs stay bounded. The operator has been alerted and will decide whether to resume it." },
  payment_review: { title: "Payment under review", body: "We received a payment that needs a manual check (for example an amount or quote mismatch). A founder will review it shortly. Nothing further is needed from you." },
  cancelled: { title: "This job was cancelled", body: "No further work will be done on this request. You can start a new one any time." },
  draft: { title: "Draft", body: "Your request was created and is being picked up by the commercial agent." },
};

export function JobView({ jobId }: { jobId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  // Stripe return URLs: ?checkout=success|cancelled and ?monitoring=success.
  const paid = params.get("checkout") === "success";
  const checkoutCancelled = params.get("checkout") === "cancelled";
  const monitoringStarted = params.get("monitoring") === "success";
  const { data, error, loading, reload } = useFetch<JobDetail>(`/api/jobs/${jobId}`);
  const [live, setLive] = useState<{ state: JobState; progress: ProgressItem[] } | null>(null);
  const lastState = useRef<JobState | null>(null);

  const state = (live?.state ?? data?.job.state) as JobState | undefined;
  const shouldPoll = !!state && (POLLING_STATES.has(state) || (state === "awaiting_payment" && paid));

  useEffect(() => {
    if (error?.status === 401) router.replace(`/signin?next=/jobs/${jobId}`);
  }, [error, router, jobId]);

  useEffect(() => {
    if (data) lastState.current = data.job.state;
  }, [data]);

  useEffect(() => {
    if (!shouldPoll) return;
    let stop = false;
    const tick = async () => {
      try {
        const p = await api<ProgressResponse>(`/api/jobs/${jobId}/progress`);
        if (stop) return;
        setLive({ state: p.state, progress: p.progress ?? [] });
        if (p.state !== lastState.current) { lastState.current = p.state; await reload(); }
      } catch { /* transient; next tick retries */ }
    };
    const id = setInterval(() => void tick(), POLL_MS);
    return () => { stop = true; clearInterval(id); };
  }, [shouldPoll, jobId, reload]);

  if (loading) return <Loading label="Loading job" />;
  if (error && error.status === 401) return <Loading label="Redirecting to sign in" />;
  if (error || !data) {
    return <ErrorBox title={error?.status === 404 ? "Job not found" : "Could not load job"} message={error?.message ?? "Unknown error"} onRetry={error?.status === 404 ? undefined : reload} />;
  }

  const { job } = data;
  const current = (live?.state ?? job.state) as JobState;
  const progress = live && live.progress.length >= data.progress.length ? live.progress : data.progress;
  const quote = data.quotes.length ? data.quotes.reduce((a, b) => (b.version > a.version ? b : a)) : null;
  const findings = data.findings.map(normalizeFinding);

  return (
    <div className="space-y-6">
      <PageTitle
        title={PACKAGE_LABEL[job.package] ?? job.package}
        sub={`Created ${when(job.createdAt)} · ${dollars(quote?.priceCents ?? PRICE_CENTS[job.package])}`}
        right={<div className="flex items-center gap-2">{job.environment === "test" && <Chip tone="warn">TEST MODE</Chip>}<StateChip state={current} /></div>}
      />
      {checkoutCancelled && (current === "quoted" || current === "awaiting_payment") && (
        <p role="status" className="rounded-2xl border border-[#ffc56b]/40 bg-[#ffc56b]/10 px-4 py-3 text-sm text-[#ffc56b]">Checkout was cancelled. You have not been charged. You can accept the quote again below.</p>
      )}
      {monitoringStarted && (
        <p role="status" className="rounded-2xl border border-[#7fd1a8]/40 bg-[#7fd1a8]/10 px-4 py-3 text-sm text-[#7fd1a8]">Monitoring pilot started. Your frozen suite will re-run nightly.</p>
      )}
      {job.retestOfJobId && (
        <p className="text-sm text-cream/70">Linked retest of <a className="text-coral underline" href={`/jobs/${job.retestOfJobId}`}>an earlier job</a>.</p>
      )}

      {data.messages.length > 0 && current !== "needs_clarification" && current !== "delivered" && (
        <Glass><h2 className="mb-3 text-sm font-semibold">Conversation</h2><Clarification jobId={jobId} messages={data.messages} canReply={false} onSent={reload} /></Glass>
      )}

      {current === "needs_clarification" && <Clarification jobId={jobId} messages={data.messages} canReply onSent={reload} />}

      {(current === "quoted" || current === "awaiting_payment") && (
        quote
          ? <QuoteCard jobId={jobId} quote={quote} jobEnv={job.environment} state={current} paid={paid} />
          : <ErrorBox title="Quote not available yet" message="The quote is still being prepared. Check back in a moment." onRetry={reload} />
      )}

      {(POLLING_STATES.has(current) || (current === "planning")) && <ProgressTimeline progress={progress} state={current} />}

      {current === "delivered" && (
        <ReportView jobId={jobId} report={data.report ?? null} findings={findings} progress={progress} onReload={reload} />
      )}

      {EXPLAIN[current] && (
        <Glass className={current === "failed" ? "border-coral/40" : undefined}>
          <h2 className="text-lg font-semibold">{EXPLAIN[current]!.title}</h2>
          <p className="mt-1 text-sm text-cream/75">{EXPLAIN[current]!.body}</p>
          {job.error && current === "failed" && <p className="mt-3 rounded-2xl bg-navy-deep/50 p-3 font-mono text-xs text-cream/80">{job.error}</p>}
          {(current === "failed" || current === "cancelled") && <div className="mt-4"><LinkBtn href="/start" variant="ghost">Start a new request</LinkBtn></div>}
        </Glass>
      )}
    </div>
  );
}
