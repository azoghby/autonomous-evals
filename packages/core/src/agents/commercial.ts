/**
 * Commercial agent services: qualification/clarification, fixed-price quotes, outreach drafts.
 * The agent picks a package and asks questions. Code owns prices and deliverables.
 * Outreach is draft-only: nothing here sends anything.
 */
import { z } from "zod";
import { findInventedPrices, PRICE_TABLE, priceLabel } from "../evals/pricing";
import { type CostEntry, type Environment, type JobRef, type MicroUsd, type PackageId, PackageIdSchema, usd } from "../evals/types";
import { redactSecrets } from "./redact";
import { TASK_BUDGETS } from "./roles";
import type { AgentTaskOutcome, AgentTaskRunner } from "./session-service";

const QuotablePackage = PackageIdSchema.exclude(["monitoring_pilot"]);
type QuotablePackage = z.infer<typeof QuotablePackage>;

/**
 * What the Commercial agent may see about a request. Built by the caller from intake;
 * deliberately has no field for credentials or full endpoint URLs.
 */
export interface IntakeSummary {
  requestedPackage: QuotablePackage;
  notes: string | null;
  systemPromptExcerpt: string | null;
  trace: { bytes: number; preview: string } | null;
  endpointHost: string | null;
  clarifications: string[];
}

export const QualifyAgentOutput = z.object({
  decision: z.enum(["quote", "clarify", "decline"]),
  recommended_package: QuotablePackage,
  questions: z.array(z.string().min(1).max(500)).max(5),
  scope_summary: z.string().min(1).max(1500),
  decline_reason: z.string().max(500).nullable(),
});
export type QualifyAgentOutput = z.infer<typeof QualifyAgentOutput>;

export interface Qualification {
  decision: "quote" | "clarify" | "decline";
  package: QuotablePackage;
  questions: string[];
  scopeSummary: string;
  /** Always the price table's list; never agent text. */
  deliverables: string[];
  declineReason: string | null;
  /** Agent text that was replaced because it broke a commercial rule. */
  policyWarnings: string[];
}

export type AgentServiceOutcome<T> =
  | { status: "completed"; value: T; taskKey: string; cost: CostEntry }
  | Exclude<AgentTaskOutcome<unknown>, { status: "completed" }>;

const passThrough = <T>(o: Exclude<AgentTaskOutcome<unknown>, { status: "completed" }>): AgentServiceOutcome<T> => o;

const safeJson = (v: unknown) => JSON.stringify(v, null, 1).replace(/</g, "\\u003c");

const menu = () =>
  (Object.values(PRICE_TABLE) as Array<(typeof PRICE_TABLE)[PackageId]>).map((o) => ({
    package: o.id,
    name: o.name,
    price: priceLabel(o),
    input_needed: o.inputNeeded,
    deliverables: o.deliverables,
  }));

export function buildQualifyMessage(intake: IntakeSummary): string {
  return `Task: qualify an inbound evaluation request.
Decide "quote" if the request fits a package and has the required input, "clarify" if you need answers first (ask at most 3 short questions), or "decline" if it is out of scope (for example: no authorization to test, requests to attack third parties, or work no package covers).
Pick recommended_package from the menu. Do not mention prices, discounts, deadlines, or deliverables that are not on the menu; the quote is computed by code from the fixed menu.

Menu:
${safeJson(menu())}

<untrusted_data>
${safeJson(intake)}
</untrusted_data>`;
}

function fallbackSummary(pkg: QuotablePackage): string {
  const o = PRICE_TABLE[pkg];
  return `${o.name}: ${o.deliverables.join("; ")}.`;
}

/** Sanitize an intake summary before it reaches a prompt. */
export function sanitizeIntake(intake: IntakeSummary, knownSecrets: readonly string[] = []): IntakeSummary {
  const r = (s: string | null, n: number) => (s ? redactSecrets(s, knownSecrets).text.slice(0, n) : null);
  return {
    requestedPackage: intake.requestedPackage,
    notes: r(intake.notes, 3_000),
    systemPromptExcerpt: r(intake.systemPromptExcerpt, 2_000),
    trace: intake.trace ? { bytes: intake.trace.bytes, preview: r(intake.trace.preview, 1_500) ?? "" } : null,
    endpointHost: intake.endpointHost,
    clarifications: intake.clarifications.slice(-5).map((c) => r(c, 1_000) ?? ""),
  };
}

export async function qualifyRequest(
  args: { job: JobRef; intake: IntakeSummary; round?: number; knownSecrets?: readonly string[]; budgetMicroUsd?: MicroUsd },
  runner: AgentTaskRunner,
): Promise<AgentServiceOutcome<Qualification>> {
  const intake = sanitizeIntake(args.intake, args.knownSecrets);
  const outcome = await runner.run({
    job: args.job,
    role: "commercial",
    // One task per clarification round, so a new customer answer starts a new session deliberately.
    purpose: `qualify_r${args.round ?? intake.clarifications.length}`,
    message: buildQualifyMessage(intake),
    output: { name: "qualify.v1", schema: QualifyAgentOutput },
    budgetMicroUsd: args.budgetMicroUsd ?? TASK_BUDGETS.qualify,
    knownSecrets: args.knownSecrets,
  });
  if (outcome.status !== "completed") return passThrough(outcome);
  const out = outcome.output;

  const policyWarnings: string[] = [];
  let scopeSummary = out.scope_summary;
  if (findInventedPrices(scopeSummary).length > 0) {
    policyWarnings.push(`scope summary mentioned prices not on the menu (${findInventedPrices(scopeSummary).join(", ")}); replaced`);
    scopeSummary = fallbackSummary(intake.requestedPackage);
  }
  const questions = out.questions.filter((q) => {
    const bad = findInventedPrices(q);
    if (bad.length) policyWarnings.push(`question dropped for mentioning prices not on the menu (${bad.join(", ")})`);
    return bad.length === 0;
  });

  let decision = out.decision;
  if (decision !== "decline" && out.recommended_package !== intake.requestedPackage) {
    decision = "clarify";
    questions.unshift(
      `You selected ${PRICE_TABLE[intake.requestedPackage].name}. Based on your request, ${PRICE_TABLE[out.recommended_package].name} may fit better. Which would you like?`,
    );
  }
  if (decision === "clarify" && questions.length === 0) {
    policyWarnings.push("agent asked to clarify without a usable question; routed to operator review");
  }
  return {
    status: "completed",
    taskKey: outcome.taskKey,
    cost: outcome.cost,
    value: {
      decision,
      package: intake.requestedPackage,
      questions: questions.slice(0, 5),
      scopeSummary,
      deliverables: [...PRICE_TABLE[intake.requestedPackage].deliverables],
      declineReason: decision === "decline" ? (out.decline_reason ?? "Out of scope for the pilot menu.") : null,
      policyWarnings,
    },
  };
}

export interface FixedQuote {
  jobId: string;
  version: number;
  package: QuotablePackage;
  priceMicroUsd: MicroUsd;
  priceCents: number;
  priceLabel: string;
  scopeSummary: string;
  deliverables: string[];
  environment: Environment;
  /** Test-mode quotes never count as revenue. */
  countsAsRevenue: boolean;
}

/** Pure: the only way a price is produced. */
export function buildQuote(job: JobRef, pkg: QuotablePackage, version: number, scopeSummary: string): FixedQuote {
  const offer = PRICE_TABLE[pkg];
  return {
    jobId: job.jobId,
    version,
    package: pkg,
    priceMicroUsd: offer.priceMicroUsd,
    priceCents: Math.round(offer.priceMicroUsd / 10_000),
    priceLabel: priceLabel(offer),
    scopeSummary: findInventedPrices(scopeSummary).length ? fallbackSummary(pkg) : scopeSummary,
    deliverables: [...offer.deliverables],
    environment: job.environment,
    countsAsRevenue: job.environment === "live" && !job.isFixture,
  };
}

// ---------------------------------------------------------------------------
// Outreach drafts (never sent by Track B)
// ---------------------------------------------------------------------------

export const OutreachDraftOutput = z.object({
  subject: z.string().min(1).max(120),
  body: z.string().min(1).max(1500),
});

export interface OutreachDraft {
  prospectId: string;
  subject: string;
  body: string;
  status: "pending_founder_approval";
}

export async function draftOutreach(
  args: { prospectId: string; teamName: string; context: string; environment: Environment },
  runner: AgentTaskRunner,
): Promise<AgentServiceOutcome<OutreachDraft>> {
  const outcome = await runner.run({
    job: { jobId: `outreach-${args.prospectId}`, environment: args.environment, isFixture: false, package: "trace_audit" },
    role: "commercial",
    purpose: "outreach_draft",
    message: `Task: draft a short, honest invitation (under 120 words) for a hackathon team to try a free first Trace Audit. No fake urgency, no invented customers, logos, results, or prices beyond the menu. A founder will review it before anything is sent.
Menu: ${safeJson(menu().map((m) => ({ name: m.name, price: m.price })))}
<untrusted_data>
${safeJson({ team: args.teamName.slice(0, 200), context: redactSecrets(args.context.slice(0, 1_500)).text })}
</untrusted_data>`,
    output: { name: "outreach.v1", schema: OutreachDraftOutput },
    budgetMicroUsd: TASK_BUDGETS.outreachDraft,
    jobCapMicroUsd: usd(0.5),
  });
  if (outcome.status !== "completed") return passThrough(outcome);
  const bad = findInventedPrices(`${outcome.output.subject} ${outcome.output.body}`);
  if (bad.length) {
    return { status: "failed", taskKey: outcome.taskKey, code: "invented_price", message: `draft mentioned prices not on the menu: ${bad.join(", ")}`, session: outcome.session, cost: outcome.cost };
  }
  return {
    status: "completed",
    taskKey: outcome.taskKey,
    cost: outcome.cost,
    value: { prospectId: args.prospectId, ...outcome.output, status: "pending_founder_approval" },
  };
}
