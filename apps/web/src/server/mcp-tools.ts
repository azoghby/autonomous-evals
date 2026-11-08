import "server-only";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import * as contracts from "@ae/core/contracts/index";
import {
  EndpointConfig, IntakeInput, PACKAGES, PRICE_CENTS, MONITORING_PRICE_CENTS_MONTHLY,
  PER_FINDING_CENTS, PER_FINDING_CAP_CENTS, PricingMode, type JobState, type Package,
} from "@ae/core/contracts/index";
import { createCheckoutForQuote, expireOpenCheckout } from "@ae/core/payments/checkout";
import { stripe } from "@ae/core/payments/stripe";
import { createJob } from "./create-job";
import { withIdempotency, IdempotencyInProgressError } from "./idempotency";
import { getJobForViewer } from "./queries";
import { addMessage, latestQuote } from "./job-store";
import { decideCancel } from "@/workflows/decisions";
import { sendJobEvent } from "@/workflows/events";
import { rerunFindingForJob, submitClarificationAnswer } from "./job-actions";
import type { Viewer } from "./access";
import { sampleBundle } from "@/app/sample/sample-report";
import { x402PayPath } from "@ae/core/payments/x402";

/** Identity of the API key's owner. Always a non-operator viewer: keys never get operator powers. */
export interface McpCaller { customerId: string; email: string; origin: string }
export interface McpToolResult { content: Array<{ type: "text"; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> }

const ok = (data: Record<string, unknown>): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data,
});
const fail = (message: string, extra?: Record<string, unknown>): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }], isError: true,
});

const viewerOf = (c: McpCaller): Viewer => ({ id: c.customerId, email: c.email, isOperator: false });
const jobUrl = (c: McpCaller, jobId: string) => `${c.origin}/jobs/${jobId}`;

/** Ownership-checked load. Missing and foreign jobs are indistinguishable. */
export const loadOwnedJob = (c: McpCaller, jobId: string) => getJobForViewer(jobId, viewerOf(c));
const NOT_FOUND = () => fail("Job not found");

const JobId = z.uuid().describe("Job id returned by create_job");


const PACKAGE_INFO: Record<(typeof PACKAGES)[number], { name: string; deliverables: string[]; input: string }> = {
  trace_audit: {
    name: "Trace audit",
    deliverables: ["Findings with evidence excerpts and severity", "Proposed fixes with verification", "Written report"],
    input: "`trace` (text of an agent transcript/tool-call log, up to 200 KB) and optional `systemPrompt`",
  },
  text_eval: {
    name: "Text endpoint eval",
    deliverables: ["Frozen scenario suite run against your endpoint", "Findings with evidence", "Proposed fixes", "Written report"],
    input: "`endpoint` {url (https), model, apiKey?, systemPrompt?, referenceText?}",
  },
  workflow_eval: {
    name: "Workflow (tool-using agent) eval",
    deliverables: ["Scenario suite with state checks", "Findings with evidence", "Proposed fixes", "Written report"],
    input: "`endpoint` {url (https), model, apiKey?, systemPrompt?}",
  },
  version_comparison: {
    name: "Version comparison (A vs B)",
    deliverables: ["Same frozen suite against both versions", "Regressions and improvements", "Written report"],
    input: "`mode` ('text'|'workflow'), `endpointA`, `endpointB`",
  },
};

/** Both pricing modes for a package. Fixed is the default; per_finding authorizes the cap and captures $3 per confirmed finding. */
export const pricingOptions = (pkg: Package, fixedCents: number = PRICE_CENTS[pkg]) => ({
  fixed: { chargeCents: fixedCents, note: "Charged once at checkout, whatever the number of findings." },
  per_finding: {
    perConfirmedFindingCents: PER_FINDING_CENTS, capCents: PER_FINDING_CAP_CENTS[pkg],
    note: `Checkout holds up to the cap on the card; at delivery only ${PER_FINDING_CENTS / 100} USD per confirmed finding is captured (never above the cap). No confirmed findings means the hold is released and you pay nothing.`,
  },
});

export const listPackages = () => ({
  currency: "usd",
  payment: "Stripe Checkout only (a human or payment-capable agent completes the returned URL). Card data is never accepted over MCP.",
  pricingModes: PricingMode.options,
  packages: PACKAGES.map((p) => ({
    package: p, ...PACKAGE_INFO[p], priceCents: PRICE_CENTS[p], pricing: pricingOptions(p),
  })),
  monitoringPriceCentsMonthly: MONITORING_PRICE_CENTS_MONTHLY,
  common: "All requests need authorizedToTest=true and a unique idempotencyKey. Optional `notes` (max 5000 chars).",
  sample: "Read the resource standard-evals://sample-report (or use the sample_report prompt) to see a finished report.",
});
/** @deprecated kept for existing callers; use listPackages. */
export const listServices = listPackages;

export const RequestEvalInput = z.object({
  package: z.enum(PACKAGES),
  trace: z.string().max(contracts.MAX_TRACE_BYTES).optional().describe("trace_audit: the agent transcript or tool-call log"),
  systemPrompt: z.string().max(20_000).optional().describe("trace_audit: the agent's system prompt (optional)"),
  endpoint: EndpointConfig.optional().describe("text_eval / workflow_eval: HTTPS endpoint to test"),
  mode: z.enum(["text", "workflow"]).optional().describe("version_comparison only"),
  endpointA: EndpointConfig.optional().describe("version_comparison: baseline"),
  endpointB: EndpointConfig.optional().describe("version_comparison: candidate"),
  notes: z.string().max(5_000).optional(),
  authorizedToTest: z.literal(true).describe("Must be true: you confirm you are authorized to test this target"),
  idempotencyKey: z.string().trim().min(1).max(200).describe("Unique per logical request; retries with the same key return the same job"),
});

export async function requestEval(c: McpCaller, input: z.infer<typeof RequestEvalInput>): Promise<McpToolResult> {
  const { idempotencyKey, ...rest } = input;
  const intake = IntakeInput.safeParse(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
  if (!intake.success) return fail("Invalid request for this package", { issues: z.flattenError(intake.error) });
  try {
    const out = await withIdempotency(`${c.customerId}:jobs.create:${idempotencyKey}`, async () => {
      const { jobId } = await createJob({ customerId: c.customerId, idempotencyKey, intake: intake.data });
      return { status: 201, body: { jobId } };
    });
    const jobId = (out.body as { jobId: string }).jobId;
    const data = await loadOwnedJob(c, jobId);
    return ok({ jobId, state: data?.job.state ?? "draft", jobUrl: jobUrl(c, jobId), replayed: out.replayed });
  } catch (err) {
    if (err instanceof IdempotencyInProgressError) return fail(err.message);
    console.error("mcp create_job failed", err);
    return fail("Could not create job");
  }
}

type FindingData = { id?: string; title?: string; status?: string; severity?: string; category?: string; description?: string; reproductions?: number; evidence?: Array<{ kind: string; excerpt: string; location?: string }> };
type JobData = NonNullable<Awaited<ReturnType<typeof loadOwnedJob>>>;

const NEXT_ACTION: Partial<Record<JobState, string>> = {
  draft: "Qualification is running. Poll get_job in 15-30s.",
  needs_clarification: "Read pendingClarificationQuestions and call answer_clarification.",
  quoted: "Review the quote, pick a pricingMode, then call accept_quote with quote.version. Pay the returned checkoutUrl.",
  awaiting_payment: "Open checkoutUrl (re-call accept_quote to get it again) and complete payment. Poll get_job.",
  planning: "Paid. Work is starting; poll get_job in 30s.",
  running: "Scenarios are running; poll get_job in 30s.",
  investigating: "Findings are being confirmed and fixes verified; poll get_job in 30s.",
  delivered: "Call get_report. Use rerun_finding to confirm a fix.",
  payment_review: "Payment needs manual review by the operator; no action needed.",
  paused_budget: "Paused by the operator on a budget limit; no action needed.",
  failed: "The job failed; see error. Create a new job with a new idempotencyKey.",
  cancelled: "Cancelled. Create a new job if you still want an eval.",
};

const summarizeFinding = (row: JobData["findings"][number]) => {
  const f = row.data as FindingData;
  return { id: row.id, findingKey: f.id, rerunOfFindingId: row.rerunOfFindingId, title: f.title, status: f.status, severity: f.severity, category: f.category };
};

export async function getJob(c: McpCaller, jobId: string): Promise<McpToolResult> {
  const data = await loadOwnedJob(c, jobId);
  if (!data) return NOT_FOUND();
  const quote = data.quotes.at(-1);
  const state = data.job.state as JobState;
  const lastCustomerIdx = data.messages.map((m) => m.role).lastIndexOf("customer");
  const questions = state === "needs_clarification"
    ? data.messages.slice(lastCustomerIdx + 1).filter((m) => m.role === "commercial").map((m) => m.body)
    : [];
  const pkg = (quote?.package ?? data.job.package) as Package;
  const quoteMode = quote ? ((quote as { pricingMode?: string }).pricingMode ?? "fixed") : null;
  const findings = (data.findings ?? []).map(summarizeFinding);
  const remediations = (data.remediations ?? []).map((r) => ({ findingKey: r.findingId, kind: r.kind, summary: r.summary, verification: r.verification?.status }));
  return ok({
    jobId, package: data.job.package, state, error: data.job.error ?? null, jobUrl: jobUrl(c, jobId),
    nextAction: NEXT_ACTION[state] ?? null,
    quote: quote ? {
      version: quote.version, package: quote.package, priceCents: quote.priceCents, scope: quote.scopeSummary,
      deliverables: quote.deliverables, accepted: !!quote.acceptedAt,
      pricingMode: quoteMode, capCents: (quote as { capCents?: number | null }).capCents ?? null,
      pricingOptions: pricingOptions(pkg, quote.priceCents),
    } : null,
    pendingClarificationQuestions: questions,
    payments: data.payments.map((p) => ({
      status: p.status, amountCents: p.amountCents, capturedAmountCents: p.capturedAmountCents ?? null,
    })),
    progress: data.progress.slice(-10).map((e) => ({ milestone: e.milestone, message: e.message, at: e.createdAt })),
    findingCount: findings.length,
    confirmedFindingCount: findings.filter((f) => f.status === "confirmed").length,
    findings,
    remediations,
    summary: data.report?.summary ?? null,
    reportReady: !!data.report,
  });
}

export async function answerClarification(c: McpCaller, jobId: string, answer: string): Promise<McpToolResult> {
  const data = await loadOwnedJob(c, jobId);
  if (!data) return NOT_FOUND();
  const r = await submitClarificationAnswer(data, answer);
  return r.ok ? ok({ ok: true, ...r.value }) : fail(r.error, r.extra);
}

/**
 * Mirrors POST /api/jobs/:id/accept-quote for an API-key owner: records acceptance, creates (or reuses) the
 * Stripe Checkout session in the chosen pricing mode and notifies the workflow. Payment itself stays in Stripe.
 */
export async function acceptQuote(c: McpCaller, jobId: string, quoteVersion: number, mode?: PricingMode): Promise<McpToolResult> {
  const data = await loadOwnedJob(c, jobId);
  if (!data) return NOT_FOUND();
  const state = data.job.state;
  if (state !== "quoted" && state !== "awaiting_payment") return fail("Job is not waiting on a quote", { state });
  const quote = await latestQuote(jobId);
  if (!quote || quote.version !== quoteVersion) return fail("That quote is out of date", { latestVersion: quote?.version ?? null });

  const pricingMode: PricingMode = mode ?? (quote.pricingMode as PricingMode);
  const modeChanged = pricingMode !== quote.pricingMode;
  const capCents = pricingMode === "per_finding" ? PER_FINDING_CAP_CENTS[quote.package] : null;
  const chargeCents = pricingMode === "per_finding" ? capCents! : quote.priceCents;

  await db().update(schema.quotes).set({ acceptedAt: sql`coalesce(${schema.quotes.acceptedAt}, now())` }).where(eq(schema.quotes.id, quote.id));

  let checkoutUrl: string | null = null;
  try {
    let retryAfterSessionId: string | undefined;
    if (quote.stripeCheckoutSessionId) {
      const existing = await stripe().checkout.sessions.retrieve(quote.stripeCheckoutSessionId);
      if (existing.payment_status === "paid" || existing.status === "complete") return fail("This quote is already paid");
      if (existing.status === "open" && existing.url && !modeChanged) checkoutUrl = existing.url;
      else {
        if (existing.status === "open") await stripe().checkout.sessions.expire(existing.id);
        retryAfterSessionId = existing.id;
      }
    }
    if (!checkoutUrl) {
      const created = await createCheckoutForQuote({
        jobId, quoteVersion: quote.version, priceCents: chargeCents, pricingMode, customerEmail: c.email,
        successUrl: `${jobUrl(c, jobId)}?checkout=success`, cancelUrl: `${jobUrl(c, jobId)}?checkout=cancelled`,
        productName: `Standard Evals: ${quote.package.replace(/_/g, " ")}`, retryAfterSessionId,
      });
      await db().update(schema.quotes).set({ stripeCheckoutSessionId: created.sessionId, pricingMode, capCents })
        .where(and(eq(schema.quotes.id, quote.id), quote.stripeCheckoutSessionId ? eq(schema.quotes.stripeCheckoutSessionId, quote.stripeCheckoutSessionId) : isNull(schema.quotes.stripeCheckoutSessionId)));
      checkoutUrl = created.url;
    }
  } catch (err) {
    console.error("mcp accept_quote checkout failed", jobId, err instanceof Error ? err.message : err);
    return fail("Could not start checkout. Please try again.");
  }
  if (state === "quoted") {
    try {
      await sendJobEvent(jobId, { type: "quote_accepted", quoteVersion: quote.version });
    } catch (err) {
      console.error("mcp accept_quote sendJobEvent failed", jobId, err instanceof Error ? err.message : err);
      return fail("Checkout was created but the job could not be notified; please retry");
    }
  }
  return ok({
    jobId, quoteVersion, pricingMode, capCents, checkoutUrl,
    pricing: pricingOptions(quote.package, quote.priceCents)[pricingMode],
    instructions: "Open checkoutUrl in a browser (a human or payment-capable agent) and pay with Stripe. Card data is never sent over MCP. Poll get_job until state leaves 'quoted'/'awaiting_payment'.",
    ...x402Option(c, jobId, pricingMode, data.job.environment),
  });
}

/** Agent-native alternative to Stripe: x402 (HTTP 402 + USDC), Base Sepolia testnet, fixed pricing, test jobs only. */
function x402Option(c: McpCaller, jobId: string, pricingMode: PricingMode, environment: string) {
  if (!process.env.X402_PAY_TO || environment !== "test" || pricingMode !== "fixed") return {};
  return {
    payWithX402: {
      url: `${c.origin}${x402PayPath(jobId)}`, method: "POST", network: "eip155:84532 (Base Sepolia testnet)", asset: "USDC",
      auth: "Authorization: Bearer <same API key as MCP>",
      howTo: "POST with no payment header -> 402 with PAYMENT-REQUIRED (x402 v2). Sign with an x402 client (e.g. @x402/fetch + @x402/evm ExactEvmScheme) and retry with PAYMENT-SIGNATURE. 200 = settled on-chain; the job resumes automatically. Use either this or checkoutUrl, not both.",
    },
  };
}

export async function cancelJob(c: McpCaller, jobId: string, reason?: string): Promise<McpToolResult> {
  const data = await loadOwnedJob(c, jobId);
  if (!data) return NOT_FOUND();
  const decision = decideCancel({ customerId: c.customerId, state: data.job.state as JobState }, viewerOf(c));
  if (!decision.allowed) return fail(decision.error, decision.status === 409 ? { state: data.job.state } : undefined);
  const why = reason || "Cancelled by the customer";
  await addMessage(jobId, "customer", `Cancellation requested: ${why}`);
  try { await expireOpenCheckout(jobId); } catch (err) {
    console.error("mcp cancel expireOpenCheckout failed", jobId, err instanceof Error ? err.message : err);
  }
  try {
    await sendJobEvent(jobId, { type: "cancel", reason: why });
  } catch (err) {
    console.error("mcp cancel sendJobEvent failed", jobId, err instanceof Error ? err.message : err);
    return fail("Cancellation recorded but the job could not be notified; please retry");
  }
  return ok({ ok: true, jobId, state: "cancelling", note: "Cancellation accepted; poll get_job to see state 'cancelled'." });
}

const EVIDENCE_EXCERPT_MAX = 600;
const REPORT_MARKDOWN_MAX = 30_000;

export async function getReport(c: McpCaller, jobId: string): Promise<McpToolResult> {
  const data = await loadOwnedJob(c, jobId);
  if (!data) return NOT_FOUND();
  if (!data.report && data.job.state !== "delivered") return fail("Report is not ready yet", { state: data.job.state });
  const findings = data.findings.map((row) => {
    const f = row.data as FindingData;
    return {
      ...summarizeFinding(row), description: f.description, reproductions: f.reproductions,
      evidence: (f.evidence ?? []).map((e) => ({ kind: e.kind, location: e.location, excerpt: e.excerpt.length > EVIDENCE_EXCERPT_MAX ? `${e.excerpt.slice(0, EVIDENCE_EXCERPT_MAX)}...` : e.excerpt })),
    };
  });
  const md = data.report?.markdown ?? "";
  return ok({
    jobId, state: data.job.state, summary: data.report?.summary ?? "",
    findings,
    remediations: (data.remediations ?? []).map(({ id: _id, createdAt: _c, ...r }) => r),
    reportMarkdown: md.slice(0, REPORT_MARKDOWN_MAX), reportTruncated: md.length > REPORT_MARKDOWN_MAX,
    howToRerun: "Pass a finding's `id` (not findingKey) to rerun_finding. Remediations link to findings through `findingKey`.",
    downloads: {
      note: "Download routes require the owner's web session (not API keys). The content above is the full report.",
      report: `${c.origin}/api/jobs/${jobId}/artifacts/report`, suite: `${c.origin}/api/jobs/${jobId}/artifacts/suite`,
    },
  });
}

export async function rerunFinding(c: McpCaller, jobId: string, findingId: string): Promise<McpToolResult> {
  const data = await loadOwnedJob(c, jobId);
  if (!data) return NOT_FOUND();
  const r = await rerunFindingForJob(data, findingId);
  return r.ok ? ok(r.value as Record<string, unknown>) : fail(r.error, r.extra);
}

export interface ToolDef { name: string; title: string; description: string; inputSchema: z.ZodObject<z.ZodRawShape>; readOnly: boolean; run: (c: McpCaller, input: never) => Promise<McpToolResult> | McpToolResult }

export const TOOLS = [
  { name: "list_packages", title: "List packages and prices", readOnly: true, inputSchema: z.object({}),
    description: "Call this first. Lists the eval packages with prices in cents, deliverables, the exact inputs each needs, and BOTH pricing modes: 'fixed' (one flat price) and 'per_finding' ($3 per confirmed finding, authorized up to a cap, nothing charged if nothing is confirmed).",
    run: () => ok(listPackages()) },
  { name: "create_job", title: "Create an eval job", readOnly: false, inputSchema: RequestEvalInput,
    description: "Hire us to evaluate an agent. Provide the inputs for the chosen package (see list_packages), authorizedToTest=true, and a unique idempotencyKey (retries with the same key return the same job and never double-create). Returns jobId; then poll get_job. Qualification and a quote follow automatically.",
    run: (c: McpCaller, i: z.infer<typeof RequestEvalInput>) => requestEval(c, i) },
  { name: "get_job", title: "Get job status", readOnly: true, inputSchema: z.object({ jobId: JobId }),
    description: "Full job state: state, nextAction, latest quote (price, scope, deliverables, pricing options), pending clarification questions, payments, last 10 progress events, findings, remediations and summary once available. Poll every 15-30s.",
    run: (c: McpCaller, i: { jobId: string }) => getJob(c, i.jobId) },
  { name: "answer_clarification", title: "Answer clarification", readOnly: false,
    inputSchema: z.object({ jobId: JobId, answer: z.string().trim().min(1).max(10_000).describe("Answer to all pending questions, in plain text") }),
    description: "Answer the questions in pendingClarificationQuestions. Only valid while state is needs_clarification.",
    run: (c: McpCaller, i: { jobId: string; answer: string }) => answerClarification(c, i.jobId, i.answer) },
  { name: "accept_quote", title: "Accept quote and get checkout URL", readOnly: false,
    inputSchema: z.object({
      jobId: JobId, quoteVersion: z.int().positive().describe("quote.version from get_job"),
      pricingMode: PricingMode.optional().describe("'fixed' (default) or 'per_finding' ($3 per confirmed finding, capped, authorized not charged up front)"),
    }),
    description: "Accept the latest quote and receive a Stripe Checkout URL in the chosen pricing mode. Payment must be completed at that URL by a human or payment-capable agent; card data never goes through MCP. Safe to call again to get the URL or switch pricing mode before paying.",
    run: (c: McpCaller, i: { jobId: string; quoteVersion: number; pricingMode?: PricingMode }) => acceptQuote(c, i.jobId, i.quoteVersion, i.pricingMode) },
  { name: "get_report", title: "Get report", readOnly: true, inputSchema: z.object({ jobId: JobId }),
    description: "The delivered report: summary, findings (each with id, severity, evidence excerpts), verified remediations (patches with before/after pass counts) and the full report as markdown. Only after state is delivered.",
    run: (c: McpCaller, i: { jobId: string }) => getReport(c, i.jobId) },
  { name: "rerun_finding", title: "Re-run a finding", readOnly: false,
    inputSchema: z.object({ jobId: JobId, findingId: z.uuid().describe("A finding's `id` from get_report/get_job (not its findingKey)") }),
    description: "Re-run one finding against the frozen scenario to check whether it still reproduces after you applied a fix. Job must be delivered; max 3 re-runs per finding.",
    run: (c: McpCaller, i: { jobId: string; findingId: string }) => rerunFinding(c, i.jobId, i.findingId) },
  { name: "cancel_job", title: "Cancel a job", readOnly: false,
    inputSchema: z.object({ jobId: JobId, reason: z.string().trim().max(1_000).optional() }),
    description: "Cancel a job before work starts (states draft, needs_clarification, quoted, awaiting_payment). An open checkout is closed so it cannot be paid. Once work has started it cannot be cancelled here.",
    run: (c: McpCaller, i: { jobId: string; reason?: string }) => cancelJob(c, i.jobId, i.reason) },
] as unknown as ToolDef[];

export const SAMPLE_REPORT_URI = "standard-evals://sample-report";

/** Markdown rendering of the static /sample report (fictional agent), for the MCP resource and prompt. */
export function sampleReportMarkdown(origin = ""): string {
  const { report, remediations, meta } = sampleBundle;
  const lines = [
    `# Sample report: ${meta.agent} (${meta.package})`, "", `_${sampleBundle.note}_`, "", "## Summary", "", report.summary, "", "## Findings", "",
  ];
  for (const f of report.findings) {
    lines.push(`### ${f.id} [${f.severity}, ${f.status}] ${f.title}`, "", f.description, "");
    for (const e of f.evidence) lines.push(`- ${e.kind}${e.location ? ` (${e.location})` : ""}: \`${e.excerpt.replace(/\n/g, " ")}\``);
    lines.push("");
  }
  lines.push("## Verified fixes", "");
  for (const r of remediations) {
    lines.push(`### ${r.findingId}: ${r.summary}`, "", r.rationale, "", "```diff", r.patch, "```", "",
      `Verification: ${r.verification.status}, before ${r.verification.before.passed}/${r.verification.before.total}, after ${r.verification.after.passed}/${r.verification.after.total}, ${r.verification.regressions} regressions.`, "");
  }
  lines.push("## Pricing", "", `Fixed from $5, or $${PER_FINDING_CENTS / 100} per confirmed finding (capped). See the list_packages tool.`);
  if (origin) lines.push("", `Web version: ${origin}/sample`);
  return lines.join("\n");
}

export const HIRE_WORKFLOW_PROMPT = (what: string) => `You are hiring Standard Evals (MCP server "standard-evals") to evaluate: ${what}

Follow this loop:
1. list_packages and pick the package that fits (trace_audit for a transcript, text_eval / workflow_eval for a live HTTPS endpoint, version_comparison for A vs B). Compare the pricing modes: fixed vs per_finding.
2. create_job with the required inputs, authorizedToTest=true and a fresh idempotencyKey.
3. Poll get_job every 15-30s. Follow nextAction. If state is needs_clarification, answer_clarification.
4. At state quoted, show the user the price and both pricing options, get their choice, then accept_quote and hand them checkoutUrl. Never ask for card details.
5. Keep polling until delivered, then get_report. Summarise findings by severity, show the verified patches, apply them, and rerun_finding on each confirmed finding to verify.
Use cancel_job only before work starts.`;
