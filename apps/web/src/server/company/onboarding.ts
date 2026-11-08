import "server-only";
/**
 * Customer Success / Onboarding agent. Talks (email or in-app chat) with SIGNED-UP customers who contacted us, collects
 * what a sandbox run needs, builds environment + suite through the sandbox service as that customer, and (via the
 * follow-through cron) starts the run once the async suite is ready and reports the result.
 * It never contacts anyone who did not write to us first and never accepts or stores credentials.
 */
import { GatewayError, generateStructured } from "@ae/core/ai/gateway";
import { replyInThread } from "@ae/core/email/agentmail";
import { COMPANY_AGENTS } from "@ae/core/company/registry";
import { PLANS, usageWindowStart } from "@ae/core/pricing/plans";
import { getCustomerPlan } from "@ae/core/payments/plans-checkout";
import {
  appendTranscript, artifactsToRequirements, buildOnboardingPrompt, computeMissing, detectSecrets, EMPTY_REQUIREMENTS,
  MAX_CUSTOMER_TEXT_CHARS, mergeRequirements, ONBOARDING_MAX_SCENARIOS, OnboardingModelOutput, OnboardingRequirements, planRunSize, SECRET_REPLY, sniffArtifacts,
  type RunPlan,
} from "@ae/core/company/onboarding";
import { formatReportMessage, summarizeRun } from "@ae/core/company/onboarding-report";
import { FOUNDER_OVERRIDE_KEY } from "@ae/core/company/onboarding";
import { recordEmailThread } from "../email-threads";
import { appUrl } from "../owner-shared";
import { runBudgetMicroUsd, type EngineSandboxService } from "../sandbox/engine-service";
import { createDbSandboxStore } from "../sandbox/store";
import { SandboxInputError } from "../sandbox/target";
import { rejectTargetUrl } from "../target-url";
import { getSandboxService } from "../sandbox-service";
import { emailDryRun, sendCompanyEmail, type CompanyEmailResult } from "./mailer";
import { buildIntake, defaultFetchSpec, HOSTED_MODELS, IntakeError, type FetchSpec } from "./onboarding-intake";
import { drizzleOnboardingStore, type Channel, type ConversationRow, type CustomerRow, type OnboardingStore } from "./onboarding-store";
import { runCompanyAgent, type AgentRunContext, type AgentRunOutcome, type RunOptions, type RunResult } from "./runtime";

export type CompanyRunOptions = Omit<RunOptions, "deps"> & { deps?: RunOptions["deps"] };
export type OnboardingSandbox = Pick<EngineSandboxService, "createDraft" | "getDraft" | "startRun" | "getRunReport">;

export interface OnboardingInput {
  customerId: string; channel: Channel; text: string; threadId?: string; conversationId?: string;
  /** Email only: lets the reply stay on the customer's thread. */
  subject?: string; inboxId?: string; messageId?: string;
  /** Chat only: files the customer attached (the route has size/type-checked them). */
  attachments?: OnboardingAttachments;
  /** Chat only: structured values from inline UI actions (model picker, endpoint field, sample world). Vetted like extracted ones. */
  fields?: OnboardingFields;
  /** Chat only: the customer's answer to the cost estimate. Skips the model call. */
  action?: "confirm" | "cancel";
  /** Chat UI: when everything is collected, wait for an explicit "confirm" before building (shows a cost estimate). */
  requireConfirm?: boolean;
}
export interface OnboardingAttachments { openapiText?: string; mcpToolsJson?: string; dataSample?: string; policies?: string }
export interface OnboardingFields { endpointUrl?: string; model?: string; systemPrompt?: string; prebuiltWorld?: "acme-support" }
export interface OnboardingResult {
  reply: string; conversationId: string; status: string; result: RunResult;
  /** Chat: everything is collected and the build waits for the customer's confirmation. */
  awaitingConfirm?: boolean;
}

export interface Allowance { headroomMicroUsd: number | null; runCapMicroUsd: number }

export interface OnboardingDeps {
  store: OnboardingStore;
  sandbox: () => OnboardingSandbox;
  generate: (prompt: string, ctx: AgentRunContext) => Promise<OnboardingModelOutput>;
  mail: typeof sendCompanyEmail;
  reply: (inboxId: string, messageId: string, text: string, to: string) => Promise<{ threadId?: string }>;
  recordThread: (threadId: string | null | undefined) => Promise<void>;
  allowance: (customerId: string, now: Date) => Promise<Allowance>;
  fetchSpec: FetchSpec;
  baseUrl: () => string;
  /** Puts an over-budget run on the founder's phone/email (kind "onboarding_run_over_budget"). Never throws. */
  flagFounder: (i: { conversationId: string; stage: "build" | "run"; summary: string }) => Promise<void>;
  runtime?: RunOptions["deps"];
}

/** Set by the founder-approval handler; lets the next build/run proceed at the minimal size (k=1, <= 3 scenarios). */
const hasOverride = (collected: Record<string, unknown>): boolean => collected[FOUNDER_OVERRIDE_KEY] === true;
const OVERRIDE_RUN = { k: 1, scenarios: 3 } as const;

const defaultFlagFounder: OnboardingDeps["flagFounder"] = async ({ conversationId, stage, summary }) => {
  try {
    const { requestFounderApproval } = await import("../notify/approvals");
    await requestFounderApproval({
      kind: "onboarding_run_over_budget", ref: `${conversationId}:${stage}`, title: "Onboarding run over the customer's plan budget",
      summary, payload: { conversationId, stage },
    });
  } catch (err) { console.error("onboarding founder flag failed", err instanceof Error ? err.message : err); }
};

const defaultGenerate: OnboardingDeps["generate"] = async (prompt, ctx) => {
  const res = await generateStructured({
    model: "sonnet", system: COMPANY_AGENTS.onboarding.system, schema: OnboardingModelOutput, prompt, ctx: ctx.gateway, maxOutputTokens: 900,
  });
  return res.object;
};

export const defaultOnboardingDeps = (): OnboardingDeps => ({
  store: drizzleOnboardingStore(),
  sandbox: getSandboxService,
  generate: defaultGenerate,
  mail: sendCompanyEmail,
  reply: (inboxId, messageId, text, to) => replyInThread(inboxId, messageId, { text, to, labels: ["company_agent", "onboarding"] }),
  recordThread: (threadId) => recordEmailThread(threadId, "onboarding", {}),
  async allowance(customerId, now) {
    const plan = await getCustomerPlan(customerId);
    const cap = PLANS[plan].limits.monthlyModelSpendCapMicroUsd;
    const used = cap == null ? null : await createDbSandboxStore().usageSince(customerId, usageWindowStart(now));
    return { headroomMicroUsd: cap == null || !used ? null : Math.max(0, cap - used.costMicroUsd), runCapMicroUsd: runBudgetMicroUsd() };
  },
  fetchSpec: defaultFetchSpec,
  baseUrl: appUrl,
  flagFounder: defaultFlagFounder,
});

const OFF = "The onboarding assistant is off right now.";
const BUSY = "I'm busy with another request for a moment. Please send that again in a minute.";
const SNAG = "I hit a snag on my side. A teammate has been notified; please try again shortly.";
const SIGN_OFF = "\n\n-- Standard Evals onboarding agent (an AI)";
const STUCK_MS = 3 * 60 * 60 * 1000;
const CANCELLED = "Okay, nothing was started. Change anything above, or tell me what's different.";

/* ---------------- delivery ---------------- */

interface Target { conv: ConversationRow; customer: CustomerRow; subject?: string; inboxId?: string; messageId?: string }

async function deliver(d: OnboardingDeps, ctx: AgentRunContext, t: Target, text: string): Promise<CompanyEmailResult["status"] | "chat"> {
  if (t.conv.channel === "chat") return "chat";
  const body = text + SIGN_OFF;
  if (!emailDryRun(ctx.dryRun) && t.inboxId && t.messageId) {
    await d.reply(t.inboxId, t.messageId, body, t.customer.email);
    return "sent";
  }
  const subject = t.subject ? (/^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`) : "Your Standard Evals sandbox run";
  const res = await d.mail({ to: t.customer.email, subject, text: body, labels: ["onboarding"] }, { dryRun: ctx.dryRun });
  if (res.status === "sent") await d.recordThread(res.sent.threadId);
  return res.status;
}

/* ---------------- building ---------------- */

const userMessage = (err: unknown): { text: string; status: "collecting" | "blocked" } => {
  if (err instanceof IntakeError) return { text: err.message, status: "collecting" };
  if (err instanceof SandboxInputError) {
    if (err.status === 402) return { text: `${err.message} A founder can help if you'd like to talk it through; just reply here.`, status: "blocked" };
    return { text: `I couldn't set that up yet: ${err.message}`, status: "collecting" };
  }
  throw err;
};

async function startBuild(d: OnboardingDeps, ctx: AgentRunContext, conversationId: string, customerId: string, collected: OnboardingRequirements, override: boolean) {
  const allowance = await d.allowance(customerId, ctx.now);
  if (!override && planRunSize({ available: 1, k: 1, headroomMicroUsd: allowance.headroomMicroUsd, runCapMicroUsd: allowance.runCapMicroUsd }).blocked) {
    if (!ctx.dryRun) await d.flagFounder({ conversationId, stage: "build", summary: "A signed-up customer's plan budget cannot cover even a minimal onboarding run (1 scenario, k=1). Approve to let the onboarding agent build and run a minimal suite anyway (k=1, up to 3 scenarios)." });
    return { status: "blocked" as const, reply: "Your plan's model budget can't cover even a minimal run right now. I've flagged this and a founder will review and get back to you here." };
  }
  try {
    const intake = await buildIntake(collected, d.fetchSpec);
    const draft = await d.sandbox().createDraft(customerId, intake);
    return {
      status: "building" as const, environmentId: draft.environmentId ?? null, suiteId: draft.draftId,
      reply: "Thanks, I have what I need. I'm building your sandbox and generating test scenarios now, which takes a few minutes. I'll start the run when they're ready and send you the results here.",
    };
  } catch (err) {
    const m = userMessage(err);
    return { status: m.status, reply: m.text };
  }
}

/** Drops unusable URLs (SSRF guard, https only) and returns a note for the customer. */
function vetUrls(next: Partial<OnboardingRequirements>): { next: Partial<OnboardingRequirements>; notes: string[] } {
  const notes: string[] = [];
  const check = (url: string | undefined, label: string): string | undefined => {
    if (!url) return undefined;
    const reason = rejectTargetUrl(url);
    if (reason) { notes.push(`I can't use the ${label} you gave (${reason}).`); return undefined; }
    return url;
  };
  return {
    notes,
    next: {
      ...next,
      agent: { ...next.agent, endpointUrl: check(next.agent?.endpointUrl, "agent endpoint") },
      tools: { ...next.tools, openapiUrl: check(next.tools?.openapiUrl, "OpenAPI URL"), mcpUrl: check(next.tools?.mcpUrl, "MCP URL") },
    },
  };
}

const STATUS_REPLY: Record<string, string> = {
  building: "Your sandbox is still being built and scenarios are being generated. I'll start the run automatically and email you the results.",
  running: "Your run is in progress. I'll send you the summary as soon as it finishes.",
  blocked: "A founder is reviewing this request, so there's nothing more you need to do right now. They'll reply here.",
};

/* ---------------- one customer turn ---------------- */

async function turn(d: OnboardingDeps, ctx: AgentRunContext, input: OnboardingInput, out: { value?: Omit<OnboardingResult, "result"> }):Promise<AgentRunOutcome> {
  const customer = await d.store.getCustomer(input.customerId);
  if (!customer) return { status: "skipped", summary: "Sender is not an active signed-up customer; ignored.", publicSummary: "Ignored a message from a non-customer." };
  const conv = await resolveConversation(d, input);
  if (!conv) return { status: "skipped", summary: "Conversation not found for customer.", publicSummary: "Ignored a message for an unknown conversation." };
  const target: Target = { conv, customer, subject: input.subject, inboxId: input.inboxId, messageId: input.messageId };
  const text = input.text.slice(0, MAX_CUSTOMER_TEXT_CHARS);
  const now = ctx.now.toISOString();
  let awaitingConfirm = false;

  const finish = async (reply: string, status: string, patch: Partial<ConversationRow> = {}, customerText = "[message]"): Promise<AgentRunOutcome> => {
    const transcript = appendTranscript(appendTranscript(conv.transcript, { role: "customer", text: customerText, at: now }), { role: "agent", text: reply, at: now });
    await d.store.update(conv.id, { ...patch, status: status as ConversationRow["status"], transcript, costMicroUsd: conv.costMicroUsd + ctx.spentMicroUsd() });
    const delivery = await deliver(d, ctx, target, reply);
    out.value = { reply, conversationId: conv.id, status, ...(awaitingConfirm ? { awaitingConfirm } : {}) };
    return {
      summary: `Onboarding turn (${conv.channel}) -> ${status}; reply ${delivery}.`, publicSummary: `Answered a customer onboarding message (${status}).`,
      counts: { turns: 1 }, detail: { conversationId: conv.id, status, delivery },
    };
  };

  const secrets = detectSecrets(text);
  const extraText = [input.fields?.systemPrompt, ...Object.values(input.attachments ?? {})].filter(Boolean).join("\n");
  if (secrets.hasSecret || (extraText && detectSecrets(extraText).hasSecret)) return finish(SECRET_REPLY, conv.status, {}, sniffArtifacts(secrets.redacted).cleaned);
  const { cleaned, found } = sniffArtifacts(text);

  if (conv.status === "building" || conv.status === "running" || conv.status === "blocked") return finish(STATUS_REPLY[conv.status]!, conv.status, {}, cleaned);
  const fresh = conv.status === "reported" || conv.status === "closed";
  const base = fresh ? EMPTY_REQUIREMENTS : OnboardingRequirements.parse(conv.collected);
  const resetIds = fresh ? { environmentId: null, suiteId: null, runId: null, reportedAt: null } : {};

  let collected = mergeRequirements(base, artifactsToRequirements(found));
  if (input.attachments) collected = mergeRequirements(collected, attachmentsToRequirements(input.attachments));
  const notes: string[] = [];
  if (input.fields) {
    const vettedFields = vetUrls(fieldsToRequirements(input.fields));
    collected = mergeRequirements(collected, vettedFields.next);
    notes.push(...vettedFields.notes);
  }
  const missingOf = (r: OnboardingRequirements) => computeMissing(r, { allowedModels: HOSTED_MODELS });

  const build = async (lead: string[]): Promise<AgentRunOutcome> => {
    const override = hasOverride(conv.collected);
    const built = await startBuild(d, ctx, conv.id, customer.id, collected, override);
    const patch: Partial<ConversationRow> = { collected: { ...collected, ...(override ? { [FOUNDER_OVERRIDE_KEY]: true } : {}) } };
    if (built.status === "building") Object.assign(patch, { environmentId: built.environmentId, suiteId: built.suiteId, runId: null, reportedAt: null });
    return finish([...lead, built.reply].filter(Boolean).join("\n\n"), built.status, patch, cleaned);
  };

  if (input.action) {
    const pending = missingOf(collected);
    if (input.action === "cancel") return finish(CANCELLED, "collecting", { collected: collected as Record<string, unknown>, ...resetIds }, cleaned);
    if (pending.length > 0) return finish(`I still need ${pending.join("; ")}.`, "collecting", { collected: collected as Record<string, unknown>, ...resetIds }, cleaned);
    return build(notes);
  }

  let modelOut: OnboardingModelOutput;
  try {
    modelOut = await d.generate(buildOnboardingPrompt({
      collected, transcript: fresh ? [] : conv.transcript, message: cleaned, missing: missingOf(collected), allowedModels: HOSTED_MODELS,
      ...(input.requireConfirm ? { surface: "chat" as const } : {}),
    }), ctx);
  } catch (err) {
    if (err instanceof GatewayError && err.code === "credential_leak") return finish(SECRET_REPLY, conv.status, {}, "[message withheld: possible credential]");
    throw err;
  }
  const vetted = vetUrls(modelOut.extracted);
  collected = mergeRequirements(collected, vetted.next);
  notes.push(...vetted.notes);
  ctx.log("turn", { missing: missingOf(collected).length, modelReady: modelOut.readyToRun });

  const missing = missingOf(collected);
  if (missing.length > 0 || input.requireConfirm) {
    if (missing.length === 0) awaitingConfirm = true;
    return finish([modelOut.reply, notes.join(" ")].filter(Boolean).join("\n\n"), "collecting", { collected: collected as Record<string, unknown>, ...resetIds }, cleaned);
  }
  return build([notes.join(" ")]);
}

const fieldsToRequirements = (f: OnboardingFields): Partial<OnboardingRequirements> => ({
  agent: { endpointUrl: f.endpointUrl, model: f.model, systemPrompt: f.systemPrompt },
  tools: f.prebuiltWorld ? { prebuiltWorld: f.prebuiltWorld } : {},
});

const attachmentsToRequirements = (a: OnboardingAttachments): Partial<OnboardingRequirements> => ({
  ...artifactsToRequirements({ openapiText: a.openapiText, mcpToolsJson: a.mcpToolsJson, dataSample: a.dataSample }),
  ...(a.policies ? { policies: a.policies } : {}),
});

async function resolveConversation(d: OnboardingDeps, input: OnboardingInput): Promise<ConversationRow | null> {
  if (input.conversationId) {
    const c = await d.store.getConversation(input.conversationId);
    return c && c.customerId === input.customerId && c.channel === input.channel ? c : null;
  }
  const existing = (input.threadId ? await d.store.findByThread(input.threadId) : null);
  if (existing) return existing.customerId === input.customerId ? existing : null;
  const latest = input.channel === "chat" ? await d.store.latestForCustomer(input.customerId, "chat") : null;
  return latest ?? d.store.create({ customerId: input.customerId, channel: input.channel, threadId: input.threadId ?? null });
}

export async function handleOnboardingMessage(
  input: OnboardingInput, opts: CompanyRunOptions = { trigger: input.channel === "email" ? "webhook" : "chat" }, deps: Partial<OnboardingDeps> = {},
): Promise<OnboardingResult> {
  const d = { ...defaultOnboardingDeps(), ...deps };
  const out: { value?: Omit<OnboardingResult, "result"> } = {};
  const trigger = opts.trigger ?? (input.channel === "email" ? "webhook" : "chat");
  const result = await runCompanyAgent("onboarding", { ...opts, trigger, deps: opts.deps ?? d.runtime }, (ctx) => turn(d, ctx, input, out));
  if (out.value) return { ...out.value, result };
  const reason = skipReason(result);
  const fallback = reason ? (reason === "disabled" ? OFF : BUSY) : result.status === "ok" ? "" : SNAG;
  return { reply: fallback, conversationId: input.conversationId ?? "", status: reason ?? result.status, result };
}

/** Why the runtime skipped the run (toggle off, lock held, daily budget), or null when it ran. */
export function skipReason(result: RunResult): "disabled" | "locked" | "daily_budget_exhausted" | null {
  return "reason" in result ? result.reason : null;
}

/* ---------------- follow-through (cron) ---------------- */

const MAX_FOLLOW_THROUGH = 20;

async function notify(d: OnboardingDeps, ctx: AgentRunContext, conv: ConversationRow, text: string, patch: Partial<ConversationRow>) {
  const customer = await d.store.getCustomer(conv.customerId);
  const transcript = appendTranscript(conv.transcript, { role: "agent", text, at: ctx.now.toISOString() });
  await d.store.update(conv.id, { ...patch, transcript });
  if (customer) await deliver(d, ctx, { conv, customer }, text);
}

type Advance = "building" | "running" | "reported" | "blocked" | "unchanged";

async function advance(d: OnboardingDeps, ctx: AgentRunContext, conv: ConversationRow): Promise<Advance> {
  const svc = d.sandbox();
  if (conv.status === "building") return advanceBuilding(d, ctx, svc, conv);
  if (!conv.runId) { await notify(d, ctx, conv, "I lost track of your run, so a founder will look into it and follow up here.", { status: "blocked" }); return "blocked"; }
  const report = await svc.getRunReport(conv.customerId, conv.runId);
  if (!report) { await notify(d, ctx, conv, "I couldn't find your run, so a founder will look into it and follow up here.", { status: "blocked" }); return "blocked"; }
  if (report.status === "failed") {
    await notify(d, ctx, conv, `Your run did not complete${report.error ? `: ${report.error}` : ""}. A founder has been flagged and will follow up here. Details: ${d.baseUrl()}/sandbox/runs/${report.runId}`, { status: "blocked" });
    return "blocked";
  }
  if (report.status !== "complete") return "unchanged";
  const text = formatReportMessage(summarizeRun(report), report.k, `${d.baseUrl()}/sandbox/runs/${report.runId}`);
  await notify(d, ctx, conv, text, { status: "reported", reportedAt: ctx.now, costMicroUsd: conv.costMicroUsd });
  return "reported";
}

async function advanceBuilding(d: OnboardingDeps, ctx: AgentRunContext, svc: OnboardingSandbox, conv: ConversationRow): Promise<Advance> {
  const draft = conv.suiteId ? await svc.getDraft(conv.customerId, conv.suiteId) : null;
  const fail = async (why: string): Promise<Advance> => { await notify(d, ctx, conv, why, { status: "blocked" }); return "blocked"; };
  if (!draft) return fail("I couldn't find your generated scenarios, so a founder will look into it and follow up here.");
  if (draft.status === "failed") return fail(`Scenario generation failed${draft.error ? `: ${draft.error}` : ""}. A founder has been flagged and will follow up here.`);
  if (draft.status !== "ready") {
    return ctx.now.getTime() - conv.updatedAt.getTime() > STUCK_MS ? fail("Scenario generation is taking much longer than expected, so a founder will look into it and follow up here.") : "unchanged";
  }
  const validated = draft.scenarios.filter((s) => s.validated);
  const pool = validated.length > 0 ? validated : draft.scenarios;
  const allowance = await d.allowance(conv.customerId, ctx.now);
  const planned = planRunSize({ available: pool.length, headroomMicroUsd: allowance.headroomMicroUsd, runCapMicroUsd: allowance.runCapMicroUsd });
  const size = planned.blocked && hasOverride(conv.collected)
    ? { ...planned, blocked: false, k: OVERRIDE_RUN.k, scenarios: Math.min(OVERRIDE_RUN.scenarios, pool.length) }
    : planned;
  if (size.blocked) {
    if (!ctx.dryRun) await d.flagFounder({ conversationId: conv.id, stage: "run", summary: `A signed-up customer's scenarios are ready but the run (estimated $${(planned.estimateMicroUsd / 1e6).toFixed(2)}) is over their plan allowance. Approve to run a minimal suite anyway (k=1, up to 3 scenarios).` });
    return fail("Your scenarios are ready, but the run's expected cost is over your plan's allowance. A founder will review it and reply here.");
  }
  const started = await svc.startRun(conv.customerId, draft.draftId, { k: size.k, scenarioIds: pool.slice(0, size.scenarios).map((s) => s.scenario.id) });
  if (!started.ok) {
    if (started.status === 429) return "unchanged"; // another run is in progress: retry on the next tick
    return fail(`I couldn't start your run: ${started.error}`);
  }
  await d.store.update(conv.id, { status: "running", runId: started.runId });
  ctx.log("run_started", { conversationId: conv.id, scenarios: size.scenarios, k: size.k });
  return "running";
}

export async function runOnboardingFollowThrough(opts: CompanyRunOptions = { trigger: "cron" }, deps: Partial<OnboardingDeps> = {}): Promise<RunResult> {
  const d = { ...defaultOnboardingDeps(), ...deps };
  return runCompanyAgent("onboarding", { ...opts, deps: opts.deps ?? d.runtime }, async (ctx) => {
    const rows = await d.store.listByStatus(["building", "running"], MAX_FOLLOW_THROUGH);
    const counts: Record<string, number> = { checked: rows.length, runsStarted: 0, reported: 0, blocked: 0, errors: 0 };
    for (const conv of rows) {
      try {
        const r = await advance(d, ctx, conv);
        if (r === "running") counts.runsStarted! += 1;
        if (r === "reported") counts.reported! += 1;
        if (r === "blocked") counts.blocked! += 1;
      } catch (err) {
        counts.errors! += 1;
        console.error("onboarding follow-through failed", conv.id, err instanceof Error ? err.message : err);
        ctx.log("follow_through_error", { conversationId: conv.id });
      }
    }
    return {
      summary: `Follow-through: ${counts.checked} open, ${counts.runsStarted} runs started, ${counts.reported} reported, ${counts.blocked} blocked, ${counts.errors} errors.`,
      publicSummary: `Checked ${counts.checked} onboarding runs; ${counts.reported} reported.`, counts,
    };
  });
}

/**
 * Chat poll: advances ONE of the customer's open conversations (build -> run -> report) right away instead of waiting
 * for the cron tick. Same logic and lock as the follow-through; foreign or idle conversations are left alone.
 */
export async function advanceOnboardingConversation(
  customerId: string, conversationId: string, opts: CompanyRunOptions = { trigger: "chat" }, deps: Partial<OnboardingDeps> = {},
): Promise<RunResult> {
  const d = { ...defaultOnboardingDeps(), ...deps };
  return runCompanyAgent("onboarding", { ...opts, deps: opts.deps ?? d.runtime }, async (ctx) => {
    const conv = await d.store.getConversation(conversationId);
    if (!conv || conv.customerId !== customerId || (conv.status !== "building" && conv.status !== "running")) {
      return { status: "skipped", summary: "Nothing to advance for this conversation.", publicSummary: "Checked an onboarding run." };
    }
    const r = await advance(d, ctx, conv);
    return { summary: `Chat follow-through: ${conv.status} -> ${r}.`, publicSummary: "Checked an onboarding run.", counts: { advanced: r === "unchanged" ? 0 : 1 } };
  });
}

/** What a run would cost right now for this customer (the chat's cost estimate), sized like the real run. */
export async function estimateOnboardingRun(customerId: string, deps: Partial<Pick<OnboardingDeps, "allowance">> = {}, now = new Date()): Promise<RunPlan & Allowance> {
  const allowance = await (deps.allowance ?? defaultOnboardingDeps().allowance)(customerId, now);
  return { ...planRunSize({ available: ONBOARDING_MAX_SCENARIOS, headroomMicroUsd: allowance.headroomMicroUsd, runCapMicroUsd: allowance.runCapMicroUsd }), ...allowance };
}
