/**
 * Shared contracts between Track A (app, workflow, payments) and Track B (agents, evals).
 * Changes here must be agreed by both tracks before editing callers or implementations.
 */
import { z } from "zod";

export const PACKAGES = ["trace_audit", "text_eval", "workflow_eval", "version_comparison"] as const;
export const Package = z.enum(PACKAGES);
export type Package = z.infer<typeof Package>;

/** Fixed pilot price table in cents. Agents may pick a package, never a price. */
export const PRICE_CENTS: Record<Package, number> = {
  trace_audit: 500,
  text_eval: 500,
  workflow_eval: 500,
  version_comparison: 1000,
};
export const MONITORING_PRICE_CENTS_MONTHLY = 4900;
/** Per-run Naive budget for one nightly monitoring re-run, in micro-USD. */
export const MONITORING_RUN_BUDGET_MICRO_USD = 1_000_000;

/** Pricing modes: 'fixed' (default, PRICE_CENTS) or 'per_finding' (authorize the cap, capture per confirmed finding). */
export const PRICING_MODES = ["fixed", "per_finding"] as const;
export const PricingMode = z.enum(PRICING_MODES);
export type PricingMode = z.infer<typeof PricingMode>;
export const PER_FINDING_CENTS = 300;
export const PER_FINDING_CAP_CENTS: Record<Package, number> = {
  trace_audit: 1500,
  text_eval: 1500,
  workflow_eval: 1500,
  version_comparison: 3000,
};
export const PAYMENT_STATUSES = ["paid", "authorized", "captured", "released", "needs_refund"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface ExpectedPayment { pricingMode: string; priceCents: number; capCents: number | null }

/** Currencies accepted as USD: card payments (usd) and x402 USDC stablecoin payments (usdc, 1:1). */
const USD_EQUIVALENT_CURRENCIES = ["usd", "usdc"];

/** Pure: does the paid amount/currency match what the quote asked for? fixed: priceCents, per_finding: capCents. */
export function paymentMatchesQuote(payment: { amountCents: number; currency: string }, quote: ExpectedPayment): boolean {
  if (!USD_EQUIVALENT_CURRENCIES.includes(payment.currency.toLowerCase())) return false;
  const expected = quote.pricingMode === "per_finding" ? quote.capCents : quote.priceCents;
  return expected != null && payment.amountCents === expected;
}


/** Revenue recognised for one payment row: captured amount for per-finding, nothing while held or after release. */
export function recognizedRevenueCents(p: { status: string; amountCents: number; capturedAmountCents: number | null }): number {
  if (p.status === "captured") return p.capturedAmountCents ?? 0;
  if (p.status === "authorized" || p.status === "released") return 0;
  return p.amountCents;
}

/** Amount to capture for a per-finding job: $3 per confirmed finding, capped. 0 means release the authorization. */
export function perFindingCaptureCents(confirmedCount: number, capCents: number): number {
  if (!Number.isInteger(confirmedCount) || confirmedCount <= 0) return 0;
  return Math.min(confirmedCount * PER_FINDING_CENTS, capCents);
}

/** Per-job Naïve budget caps in micro-USD, reserved before dispatch. */
export const JOB_BUDGET_MICRO_USD: Record<Package, number> = {
  trace_audit: 3_000_000,
  text_eval: 3_000_000,
  workflow_eval: 3_000_000,
  version_comparison: 5_000_000,
};

export const JOB_STATES = [
  "draft", "needs_clarification", "quoted", "awaiting_payment", "planning", "running",
  "investigating", "delivered", "payment_review", "paused_budget", "failed", "cancelled",
] as const;
export const JobState = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobState>;

export const Environment = z.enum(["live", "test"]);
export type Environment = z.infer<typeof Environment>;

export const MAX_TRACE_BYTES = 200 * 1024;

export const EndpointConfig = z.object({
  url: z.url().refine((u) => u.startsWith("https://"), "Endpoint must use HTTPS"),
  model: z.string().min(1).max(200),
  /** Plaintext only in transit; stored encrypted, never sent to agents or logs. */
  apiKey: z.string().min(1).max(500).optional(),
  systemPrompt: z.string().max(20_000).default(""),
  referenceText: z.string().max(50_000).optional(),
});
export type EndpointConfig = z.infer<typeof EndpointConfig>;

export const IntakeInput = z.discriminatedUnion("package", [
  z.object({
    package: z.literal("trace_audit"),
    trace: z.string().min(1).max(MAX_TRACE_BYTES),
    systemPrompt: z.string().max(20_000).optional(),
    notes: z.string().max(5_000).optional(),
    authorizedToTest: z.literal(true),
  }),
  z.object({
    package: z.literal("text_eval"),
    endpoint: EndpointConfig,
    notes: z.string().max(5_000).optional(),
    authorizedToTest: z.literal(true),
  }),
  z.object({
    package: z.literal("workflow_eval"),
    endpoint: EndpointConfig,
    notes: z.string().max(5_000).optional(),
    authorizedToTest: z.literal(true),
  }),
  z.object({
    package: z.literal("version_comparison"),
    mode: z.enum(["text", "workflow"]),
    endpointA: EndpointConfig,
    endpointB: EndpointConfig,
    notes: z.string().max(5_000).optional(),
    authorizedToTest: z.literal(true),
  }),
]);
export type IntakeInput = z.infer<typeof IntakeInput>;

/** Commercial agent output (Track B: qualify). */
export const QualifyResult = z.object({
  decision: z.enum(["quote", "clarify", "decline"]),
  package: Package,
  questions: z.array(z.string().max(1_000)).max(5).default([]),
  scopeSummary: z.string().max(4_000),
  deliverables: z.array(z.string().max(500)).max(10),
  declineReason: z.string().max(1_000).optional(),
});
export type QualifyResult = z.infer<typeof QualifyResult>;

export const Quote = z.object({
  jobId: z.uuid(),
  version: z.int().positive(),
  package: Package,
  priceCents: z.int().nonnegative(),
  scopeSummary: z.string(),
  deliverables: z.array(z.string()),
  environment: Environment,
});
export type Quote = z.infer<typeof Quote>;

export const Scenario = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(300),
  category: z.string().max(100),
  input: z.string().max(10_000),
  checks: z.array(z.object({
    kind: z.enum(["objective", "rubric", "state"]),
    description: z.string().max(1_000),
    spec: z.record(z.string(), z.unknown()).default({}),
  })).min(1),
});
export type Scenario = z.infer<typeof Scenario>;

export const Suite = z.object({
  jobId: z.uuid(),
  versionLabel: z.string().default("default"),
  frozenAt: z.iso.datetime(),
  scenarios: z.array(Scenario).max(32), // 12 designed + red-team pack (rt_*)
});
export type Suite = z.infer<typeof Suite>;

export const FindingStatus = z.enum(["confirmed", "rubric_concern", "inconclusive"]);
export const Severity = z.enum(["critical", "high", "medium", "low"]);

export const Evidence = z.object({
  kind: z.enum(["trace_excerpt", "tool_call", "response", "state_diff", "judge"]),
  excerpt: z.string().max(10_000),
  location: z.string().max(300).optional(),
});

export const Finding = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(300),
  status: FindingStatus,
  severity: Severity,
  category: z.enum([
    "unsupported_claim", "ignored_error", "instruction_violation", "unsafe_action",
    "factual", "state_mismatch", "false_success", "other",
  ]),
  description: z.string().max(5_000),
  scenarioId: z.string().optional(),
  evidence: z.array(Evidence).min(1),
  reproductions: z.int().min(0).max(3).default(0),
});
export type Finding = z.infer<typeof Finding>;

/** Pass counts before/after applying a remediation to the relevant frozen scenario(s) / trace re-check. */
export const PassCounts = z.object({ passed: z.int().min(0), total: z.int().min(0) });

/** "Fix, not just find": a proposed remediation for a confirmed finding plus its verification evidence. */
export const Remediation = z.object({
  findingId: z.string().min(1).max(64),
  kind: z.enum(["prompt_patch", "tool_schema", "guardrail", "other"]),
  summary: z.string().max(500),
  /** Unified diff or replacement text. */
  patch: z.string().max(20_000),
  rationale: z.string().max(2_000),
  verification: z.object({
    status: z.enum(["verified", "partially_verified", "not_verified"]),
    before: PassCounts,
    after: PassCounts,
    regressions: z.int().min(0),
    evidence: z.array(Evidence).max(5),
  }),
});
export type Remediation = z.infer<typeof Remediation>;

export const CostEntry = z.object({
  jobId: z.uuid(),
  source: z.enum(["naive", "ai_gateway"]),
  agent: z.enum(["commercial", "engineer", "investigator", "operator", "judge"]).optional(),
  sessionId: z.string().optional(),
  microUsd: z.int().nonnegative(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type CostEntry = z.infer<typeof CostEntry>;

export const ProgressEvent = z.object({
  jobId: z.uuid(),
  milestone: z.string().max(100),
  message: z.string().max(1_000),
  at: z.iso.datetime(),
});
export type ProgressEvent = z.infer<typeof ProgressEvent>;

export const Report = z.object({
  jobId: z.uuid(),
  summary: z.string().max(10_000),
  markdown: z.string(),
  html: z.string(),
  findings: z.array(Finding),
  monitoringPitch: z.string().max(2_000).optional(),
});
export type Report = z.infer<typeof Report>;

/** Events delivered to a job's workflow via its single start hook (token = jobHookToken). */
export const JobEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("clarification_answer"), answer: z.string().max(10_000) }),
  z.object({ type: z.literal("quote_accepted"), quoteVersion: z.int().positive() }),
  z.object({ type: z.literal("payment_confirmed"), paymentId: z.uuid(), quoteVersion: z.int().positive() }),
  z.object({ type: z.literal("cancel"), reason: z.string().max(1_000) }),
]);
export type JobEvent = z.infer<typeof JobEvent>;
export const jobHookToken = (jobId: string) => `job:${jobId}`;
