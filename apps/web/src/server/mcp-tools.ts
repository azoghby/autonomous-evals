import "server-only";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import * as contracts from "@ae/core/contracts/index";
import { EndpointConfig, IntakeInput, PACKAGES, PRICE_CENTS, MONITORING_PRICE_CENTS_MONTHLY } from "@ae/core/contracts/index";
import { createJob } from "./create-job";
import { withIdempotency, IdempotencyInProgressError } from "./idempotency";
import { getJobForViewer } from "./queries";
import { latestQuote } from "./job-store";
import { rerunFindingForJob, submitClarificationAnswer } from "./job-actions";
import type { Viewer } from "./access";

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

const JobId = z.uuid().describe("Job id returned by request_eval");

const PER_FINDING = (contracts as Record<string, unknown>).PER_FINDING_CENTS as number | undefined;
const PER_FINDING_CAP = (contracts as Record<string, unknown>).PER_FINDING_CAP_CENTS as Record<string, number> | undefined;

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

export const listServices = () => ({
  currency: "usd",
  payment: "Stripe Checkout only (a human or payment-capable agent completes it at the job page). Card data is never accepted over MCP.",
  packages: PACKAGES.map((p) => ({
    package: p, ...PACKAGE_INFO[p], priceCents: PRICE_CENTS[p],
    ...(PER_FINDING && PER_FINDING_CAP
      ? { perFindingOption: { perConfirmedFindingCents: PER_FINDING, capCents: PER_FINDING_CAP[p], note: "Authorize up to the cap; capture $3 per confirmed finding. Chosen at checkout." } }
      : {}),
  })),
  monitoringPriceCentsMonthly: MONITORING_PRICE_CENTS_MONTHLY,
  common: "All requests need authorizedToTest=true and a unique idempotencyKey. Optional `notes` (max 5000 chars).",
});

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
    console.error("mcp request_eval failed", err);
    return fail("Could not create job");
  }
}

export async function getJob(c: McpCaller, jobId: string): Promise<McpToolResult> {
  const data = await loadOwnedJob(c, jobId);
  if (!data) return NOT_FOUND();
  const quote = data.quotes.at(-1);
  const lastCustomerIdx = data.messages.map((m) => m.role).lastIndexOf("customer");
  const questions = data.job.state === "needs_clarification"
    ? data.messages.slice(lastCustomerIdx + 1).filter((m) => m.role === "commercial").map((m) => m.body)
    : [];
  return ok({
    jobId, package: data.job.package, state: data.job.state, error: data.job.error ?? null, jobUrl: jobUrl(c, jobId),
    quote: quote ? {
      version: quote.version, package: quote.package, priceCents: quote.priceCents, scope: quote.scopeSummary,
      deliverables: quote.deliverables, accepted: !!quote.acceptedAt,
      pricingMode: (quote as { pricingMode?: string }).pricingMode ?? "fixed",
    } : null,
    pendingClarificationQuestions: questions,
    payments: data.payments.map((p) => ({ status: (p as { status?: string }).status, amountCents: (p as { amountCents?: number }).amountCents })),
    progress: data.progress.slice(-10).map((e) => ({ milestone: e.milestone, message: e.message, at: e.createdAt })),
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
 * Payment always goes through Stripe Checkout. The accept-quote route owns the checkout logic (and is being
 * changed for pricing modes), so the tool hands back the job page where the owner accepts and pays.
 */
export async function acceptQuote(c: McpCaller, jobId: string, quoteVersion: number, pricingMode?: string): Promise<McpToolResult> {
  const data = await loadOwnedJob(c, jobId);
  if (!data) return NOT_FOUND();
  const state = data.job.state;
  if (state !== "quoted" && state !== "awaiting_payment") return fail("Job is not waiting on a quote", { state });
  const quote = await latestQuote(jobId);
  if (!quote || quote.version !== quoteVersion) return fail("That quote is out of date", { latestVersion: quote?.version ?? null });
  return ok({
    jobId, quoteVersion, state, priceCents: quote.priceCents, requestedPricingMode: pricingMode ?? null,
    checkoutUrl: jobUrl(c, jobId),
    instructions: "A human or payment-capable agent signs in as the key owner, opens checkoutUrl, accepts the quote (choosing the pricing mode) and completes Stripe Checkout. Poll get_job until state leaves 'quoted'/'awaiting_payment'.",
  });
}

const EVIDENCE_EXCERPT_MAX = 600;
const REPORT_MARKDOWN_MAX = 30_000;

export async function getReport(c: McpCaller, jobId: string): Promise<McpToolResult> {
  const data = await loadOwnedJob(c, jobId);
  if (!data) return NOT_FOUND();
  if (!data.report && data.job.state !== "delivered") return fail("Report is not ready yet", { state: data.job.state });
  const rems = await db().select().from(schema.remediations).where(eq(schema.remediations.jobId, jobId)).orderBy(desc(schema.remediations.createdAt));
  const findings = data.findings.map((row) => {
    const f = row.data as { title?: string; status?: string; severity?: string; category?: string; description?: string; evidence?: Array<{ kind: string; excerpt: string; location?: string }> };
    return {
      id: row.id, rerunOfFindingId: row.rerunOfFindingId, title: f.title, status: f.status, severity: f.severity, category: f.category,
      description: f.description,
      evidence: (f.evidence ?? []).map((e) => ({ kind: e.kind, location: e.location, excerpt: e.excerpt.length > EVIDENCE_EXCERPT_MAX ? `${e.excerpt.slice(0, EVIDENCE_EXCERPT_MAX)}…` : e.excerpt })),
    };
  });
  const md = data.report?.markdown ?? "";
  return ok({
    jobId, state: data.job.state, summary: data.report?.summary ?? "",
    findings,
    remediations: rems.map((r) => ({ findingRowId: r.findingRowId, ...(r.data as Record<string, unknown>) })),
    reportMarkdown: md.slice(0, REPORT_MARKDOWN_MAX), reportTruncated: md.length > REPORT_MARKDOWN_MAX,
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
  { name: "list_services", title: "List services", readOnly: true, inputSchema: z.object({}),
    description: "List eval packages with fixed prices, deliverables and the input each one needs. Call this first.",
    run: () => ok(listServices()) },
  { name: "request_eval", title: "Request an eval", readOnly: false, inputSchema: RequestEvalInput,
    description: "Create an eval job (qualification and quote start automatically). Provide the inputs for the chosen package (see list_services), authorizedToTest=true and a unique idempotencyKey. Returns jobId; poll get_job.",
    run: (c: McpCaller, i: z.infer<typeof RequestEvalInput>) => requestEval(c, i) },
  { name: "get_job", title: "Get job status", readOnly: true, inputSchema: z.object({ jobId: JobId }),
    description: "State, latest quote (price, scope, deliverables), pending clarification questions, and the last 10 progress events. Poll every 15-30s.",
    run: (c: McpCaller, i: { jobId: string }) => getJob(c, i.jobId) },
  { name: "answer_clarification", title: "Answer clarification", readOnly: false,
    inputSchema: z.object({ jobId: JobId, answer: z.string().trim().min(1).max(10_000) }),
    description: "Answer the clarification questions shown by get_job when state is needs_clarification.",
    run: (c: McpCaller, i: { jobId: string; answer: string }) => answerClarification(c, i.jobId, i.answer) },
  { name: "accept_quote", title: "Accept quote", readOnly: false,
    inputSchema: z.object({ jobId: JobId, quoteVersion: z.int().positive(), pricingMode: z.enum(["fixed", "per_finding"]).optional() }),
    description: "Accept the latest quote (pass its version). Returns the checkout URL; payment is completed in Stripe Checkout by a human or payment-capable agent. Never send card data.",
    run: (c: McpCaller, i: { jobId: string; quoteVersion: number; pricingMode?: string }) => acceptQuote(c, i.jobId, i.quoteVersion, i.pricingMode) },
  { name: "get_report", title: "Get report", readOnly: true, inputSchema: z.object({ jobId: JobId }),
    description: "Delivered report: summary, findings (title, status, severity, truncated evidence), remediations and report markdown.",
    run: (c: McpCaller, i: { jobId: string }) => getReport(c, i.jobId) },
  { name: "rerun_finding", title: "Re-run a finding", readOnly: false,
    inputSchema: z.object({ jobId: JobId, findingId: z.uuid().describe("Finding id from get_report") }),
    description: "Re-run one finding against the frozen scenario to check it reproduces or a fix works. Max 3 re-runs per finding; job must be delivered.",
    run: (c: McpCaller, i: { jobId: string; findingId: string }) => rerunFinding(c, i.jobId, i.findingId) },
] as unknown as ToolDef[];
