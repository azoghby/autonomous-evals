"use client";
import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PRICE_CENTS, type JobState } from "@ae/core/contracts/index";
import { dollars, PACKAGE_LABEL, when } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import { normalizeFinding, type JobDetail } from "@/lib/client/types";
import { useLiveJob } from "@/lib/client/use-live-job";
import { AnimatePresence } from "motion/react";
import { Banner, Chip, ErrorBox, LiveChip, Block, Loading, LinkBtn, PageTitle, StateChip } from "./ui";
import { Clarification } from "./job-clarification";
import { QuoteCard } from "./job-quote";
import { ProgressTimeline } from "./job-progress";
import { ReportView } from "./job-report";

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
  const lastState = useRef<JobState | null>(null);

  const detailState = data?.job.state as JobState | undefined;
  const shouldPoll = !!detailState && (POLLING_STATES.has(detailState) || detailState === "draft" || (detailState === "awaiting_payment" && paid));
  // Neon Realtime with automatic fallback to 3s polling of /api/jobs/:id/progress.
  const feed = useLiveJob(jobId, shouldPoll);
  const live = feed.state ? { state: feed.state, progress: feed.progress ?? [] } : null;

  useEffect(() => {
    if (error?.status === 401) router.replace(`/signin?next=/jobs/${jobId}`);
  }, [error, router, jobId]);

  useEffect(() => {
    if (data) lastState.current = data.job.state;
  }, [data]);

  useEffect(() => {
    if (!feed.state) return;
    if (feed.state !== lastState.current) { lastState.current = feed.state; void reload(); }
  }, [feed.state, reload]);

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
  const pricingMode = quote?.pricingMode ?? "fixed";
  const charge = data.payments.length ? data.payments[data.payments.length - 1] : null;

  return (
    <div className="space-y-10">
      <PageTitle
        title={PACKAGE_LABEL[job.package] ?? job.package}
        sub={`Created ${when(job.createdAt)} · ${dollars(quote?.priceCents ?? PRICE_CENTS[job.package])}`}
        right={<div className="flex items-center gap-5">{feed.mode === "live" && shouldPoll && <LiveChip />}{job.environment === "test" && <Chip tone="warn">Test mode</Chip>}<StateChip state={current} /></div>}
      />
      <AnimatePresence initial={false}>
        {checkoutCancelled && (current === "quoted" || current === "awaiting_payment") && (
          <Banner key="cc" tone="warn">Checkout was cancelled. You have not been charged. You can accept the quote again below.</Banner>
        )}
        {monitoringStarted && <Banner key="mon" tone="ok">Monitoring pilot started. Your frozen suite will re-run nightly.</Banner>}
      </AnimatePresence>
      {job.retestOfJobId && (
        <p className="text-sm text-muted">Linked retest of <a className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-accent-bright" href={`/jobs/${job.retestOfJobId}`}>an earlier job</a>.</p>
      )}

      {data.messages.length > 0 && current !== "needs_clarification" && current !== "delivered" && (
        <Block title="Conversation"><Clarification jobId={jobId} messages={data.messages} canReply={false} onSent={reload} /></Block>
      )}

      {current === "needs_clarification" && <Clarification jobId={jobId} messages={data.messages} canReply onSent={reload} />}

      {(current === "quoted" || current === "awaiting_payment") && (
        quote
          ? <QuoteCard jobId={jobId} quote={quote} jobEnv={job.environment} state={current} paid={paid} />
          : <ErrorBox title="Quote not available yet" message="The quote is still being prepared. Check back in a moment." onRetry={reload} />
      )}

      {(POLLING_STATES.has(current) || (current === "planning")) && <ProgressTimeline progress={progress} state={current} />}

      {current === "delivered" && (
        <ReportView jobId={jobId} report={data.report ?? null} findings={findings} progress={progress} onReload={reload} remediations={data.remediations ?? []} charge={charge} pricingMode={pricingMode} />
      )}

      {EXPLAIN[current] && (
        <Block>
          <h2 className="text-lg font-medium">{EXPLAIN[current]!.title}</h2>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted">{EXPLAIN[current]!.body}</p>
          {job.error && current === "failed" && <p className="mt-3 rounded-md border border-line bg-bg-raised p-3 font-mono text-xs text-muted">{job.error}</p>}
          {(current === "failed" || current === "cancelled") && <div className="mt-4"><LinkBtn href="/start" variant="ghost">Start a new request</LinkBtn></div>}
        </Block>
      )}
    </div>
  );
}
