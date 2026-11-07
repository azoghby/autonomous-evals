"use client";
import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PRICE_CENTS, type JobState } from "@ae/core/contracts/index";
import { dollars, PACKAGE_LABEL, when } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import { normalizeFinding, type JobDetail } from "@/lib/client/types";
import { useLiveJob } from "@/lib/client/use-live-job";
import { AnimatePresence } from "motion/react";
import { Button, Chip, KeyValue, Reveal, StatusChip } from "@/components/ui";
import { Banner, ErrorBox, LiveChip, Loading } from "./ui";
import { MetaDot, PageHead, Panel } from "./page-parts";
import { Clarification } from "./job-clarification";
import { QuoteCard } from "./job-quote";
import { ProgressTimeline } from "./job-progress";
import { ReportView } from "./job-report";

const LEAD: Partial<Record<JobState, string>> = {
  draft: "Your request is being picked up by the commercial agent.",
  needs_clarification: "The agent has a question before it can quote you.",
  quoted: "Review the scope and price, then accept to start.",
  awaiting_payment: "Waiting on payment before work begins.",
  planning: "An agent is planning the checks to run.",
  running: "Checks are running now. This page updates live.",
  investigating: "Failures are being investigated and confirmed.",
  delivered: "Your report is ready.",
  payment_review: "A payment needs a manual check.",
  paused_budget: "Paused at the compute budget cap.",
  failed: "This job did not complete.",
  cancelled: "This job was cancelled.",
};

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

  const priceCents = quote?.priceCents ?? PRICE_CENTS[job.package];
  const pkgLabel = PACKAGE_LABEL[job.package] ?? job.package;
  const charged = charge?.capturedAmountCents ? dollars(charge.capturedAmountCents) : "None yet";

  return (
    <div>
      <PageHead
        eyebrow={`Job · ${job.id.slice(0, 8)}`}
        title={pkgLabel}
        lead={LEAD[current]}
        meta={<>
          <span>{pkgLabel}</span><MetaDot />
          <span>Created {when(job.createdAt)}</span><MetaDot />
          <span className="t-data text-fg-2">{dollars(priceCents)}</span><MetaDot />
          <StatusChip status={current} />
          {feed.mode === "live" && shouldPoll && <LiveChip />}
          {job.environment === "test" && <Chip tone="warn">Test mode</Chip>}
        </>}
      />

      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-12">
        <div className="min-w-0 space-y-8 lg:col-span-8">
          <AnimatePresence initial={false}>
            {checkoutCancelled && (current === "quoted" || current === "awaiting_payment") && (
              <Banner key="cc" tone="warn">Checkout was cancelled. You have not been charged. You can accept the quote again below.</Banner>
            )}
            {monitoringStarted && <Banner key="mon" tone="ok">Monitoring pilot started. Your frozen suite will re-run nightly.</Banner>}
          </AnimatePresence>
          {job.retestOfJobId && (
            <p className="text-sm text-muted">Linked retest of <a className="text-fg underline decoration-line-3 underline-offset-4 hover:decoration-accent" href={`/jobs/${job.retestOfJobId}`}>an earlier job</a>.</p>
          )}

          {data.messages.length > 0 && current !== "needs_clarification" && current !== "delivered" && (
            <Panel title="Conversation"><Clarification jobId={jobId} messages={data.messages} canReply={false} onSent={reload} /></Panel>
          )}

          {current === "needs_clarification" && <Clarification jobId={jobId} messages={data.messages} canReply onSent={reload} />}

          {(current === "quoted" || current === "awaiting_payment") && (
            quote
              ? <QuoteCard jobId={jobId} quote={quote} jobEnv={job.environment} state={current} paid={paid} />
              : <ErrorBox title="Quote not available yet" message="The quote is still being prepared. Check back in a moment." onRetry={reload} />
          )}

          {(POLLING_STATES.has(current) || (current === "planning")) && <ProgressTimeline progress={progress} state={current} />}

          {current === "delivered" && (
            <ReportView jobId={jobId} report={data.report ?? null} findings={findings} progress={progress} onReload={reload} remediations={data.remediations ?? []} charge={charge} pricingMode={pricingMode} quote={quote} />
          )}

          {EXPLAIN[current] && (
            <Reveal>
              <Panel title="Status">
                <h2 className="t-h3 text-fg">{EXPLAIN[current]!.title}</h2>
                <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-muted">{EXPLAIN[current]!.body}</p>
                {job.error && current === "failed" && <p className="t-data mt-4 rounded-[4px] border border-line-2 bg-bg p-3 text-muted">{job.error}</p>}
                {(current === "failed" || current === "cancelled") && <div className="mt-5"><Button href="/start" variant="outline">Start a new request</Button></div>}
              </Panel>
            </Reveal>
          )}
        </div>

        <aside className="self-start lg:sticky lg:top-24 lg:col-span-4" aria-label="Job details">
          <div>
            <p className="t-eyebrow mb-3 text-subtle">Details</p>
            <dl className="border-t border-line-2">
              <KeyValue label="Package">{pkgLabel}</KeyValue>
              <KeyValue label="Created">{when(job.createdAt)}</KeyValue>
              <KeyValue label="Pricing">{pricingMode === "per_finding" ? "Per finding" : "Fixed"}</KeyValue>
              <KeyValue label="Quoted"><span className="t-data">{dollars(priceCents)}</span></KeyValue>
              <KeyValue label="Charged"><span className="t-data">{charged}</span></KeyValue>
              <KeyValue label="Environment">{job.environment === "test" ? "Test" : "Live"}</KeyValue>
              <KeyValue label="Job"><span className="t-data">{job.id.slice(0, 8)}</span></KeyValue>
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}
