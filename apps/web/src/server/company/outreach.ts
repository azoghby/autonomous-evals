import "server-only";
/**
 * Outreach (SDR) agent: drafts first-touch / follow-up emails into the existing founder approval queue
 * (outreach_drafts status "pending"). It NEVER sends: sending happens only in outreach-approve.ts after a human approves.
 */
import { generateStructured } from "@ae/core/ai/gateway";
import { withNaive } from "./naive-runtime";
import { COMPANY_AGENTS } from "@ae/core/company/registry";
import { outreachDailyCap, startOfUtcDay } from "@ae/core/company/policy";
import {
  DEDUPE_WINDOW_MS, buildOutreachPrompt, emailDomain, finalizeOutreachEmail, isFollowUpDue, isOptOut,
  outreachEmailSchema, runDraftLimit, validateOutreachEmail, type OutreachEmail, type SdrKind,
} from "@ae/core/company/outreach";
import { runCompanyAgent, type AgentRunContext, type AgentRunOutcome, type RunOptions, type RunResult } from "./runtime";
import { containsLocalUrl } from "../public-url";
import { drizzleOutreachStore, type OutreachLead, type OutreachStore } from "./outreach-store";

export type CompanyRunOptions = Omit<RunOptions, "deps"> & { deps?: RunOptions["deps"] };

export type DraftGenerator = (lead: OutreachLead, kind: SdrKind, ctx: AgentRunContext) => Promise<OutreachEmail>;

export interface OutreachDeps {
  store: OutreachStore;
  generate: DraftGenerator;
  runtime?: RunOptions["deps"];
}

const defaultGenerate: DraftGenerator = async (lead, kind, ctx) => {
  const res = await withNaive("outreach", generateStructured)({
    model: "sonnet", system: COMPANY_AGENTS.outreach.system, schema: outreachEmailSchema,
    prompt: buildOutreachPrompt(lead, kind), ctx: ctx.gateway, maxOutputTokens: 600,
  });
  return res.object;
};

interface Counts {
  drafted: number; skippedSuppressed: number; skippedDuplicate: number;
  rejectedByValidator: number; followUps: number; capRemaining: number;
}

type DraftOutcome = "drafted" | "suppressed" | "duplicate" | "rejected" | "error";

async function draftOne(
  lead: OutreachLead, kind: SdrKind, ctx: AgentRunContext, d: OutreachDeps, domainsSeen: Set<string>,
): Promise<DraftOutcome> {
  const { store } = d;
  const email = lead.contactEmail.trim().toLowerCase();
  if (await store.isSuppressed(email)) {
    if (kind === "sdr_first_touch") await store.setLead(lead.id, { status: "suppressed" });
    return "suppressed";
  }
  if (kind === "sdr_first_touch") {
    const since = new Date(ctx.now.getTime() - DEDUPE_WINDOW_MS);
    const dom = emailDomain(email);
    if (domainsSeen.has(lead.domain) || domainsSeen.has(dom) || (await store.recentDraftExists(email, dom, since))) return "duplicate";
  }
  let raw: OutreachEmail;
  try {
    raw = await d.generate(lead, kind, ctx);
  } catch (err) {
    console.error("outreach generate failed", err instanceof Error ? err.message : err);
    ctx.log("generate_failed", { leadId: lead.id });
    return "error";
  }
  const verdict = validateOutreachEmail(raw, { appUrl: store.appUrl() });
  if (!verdict.ok) {
    ctx.log("validator_rejected", { leadId: lead.id, reasons: verdict.reasons });
    return "rejected";
  }
  const final = finalizeOutreachEmail(raw, { email, unsubscribeUrl: store.unsubscribeUrl(email), companyAddress: store.companyAddress() });
  if (containsLocalUrl(`${final.subject}\n${final.body}`)) {
    ctx.log("validator_rejected", { leadId: lead.id, reasons: ["local_url"] });
    return "rejected";
  }
  const draftId = await store.insertDraft({ toEmail: email, subject: final.subject, body: final.body, kind });
  if (kind === "sdr_first_touch") await store.setLead(lead.id, { status: "drafted", outreachDraftId: draftId });
  // Founder's phone/email approval request (same "outreach_draft" kind as the console queue). Skipped on dry runs.
  if (!ctx.dryRun) await store.notifyDraft?.({ id: draftId, kind, toEmail: email, subject: final.subject });
  domainsSeen.add(lead.domain); domainsSeen.add(emailDomain(email));
  ctx.log("draft_created", { leadId: lead.id, draftId, kind });
  return "drafted";
}

export const outreachPublicSummary = (c: Counts, cap: number): string =>
  `Drafted ${c.drafted} first-touch email${c.drafted === 1 ? "" : "s"} and ${c.followUps} follow-up${c.followUps === 1 ? "" : "s"} for founder approval (cap ${cap}/day). Nothing sent.`;

async function runBody(ctx: AgentRunContext, d: OutreachDeps): Promise<AgentRunOutcome> {
  const { store } = d;
  const cap = outreachDailyCap();
  const draftedToday = await store.countSdrDraftsSince(startOfUtcDay(ctx.now));
  let budget = runDraftLimit(cap, draftedToday);
  const c: Counts = { drafted: 0, skippedSuppressed: 0, skippedDuplicate: 0, rejectedByValidator: 0, followUps: 0, capRemaining: 0 };
  const seen = new Set<string>();
  const tally = (o: DraftOutcome, kind: SdrKind): void => {
    if (o === "drafted") { budget--; if (kind === "sdr_follow_up") c.followUps++; else c.drafted++; }
    else if (o === "suppressed") c.skippedSuppressed++;
    else if (o === "duplicate") c.skippedDuplicate++;
    else if (o === "rejected") c.rejectedByValidator++;
  };

  if (budget > 0) {
    for (const lead of await store.followUpLeads()) {
      if (budget <= 0) break;
      if (!isFollowUpDue(lead, ctx.now)) continue;
      tally(await draftOne(lead, "sdr_follow_up", ctx, d, seen), "sdr_follow_up");
    }
  }
  if (budget > 0) {
    for (const lead of await store.newLeads(budget * 5 + 10)) {
      if (budget <= 0) break;
      tally(await draftOne(lead, "sdr_first_touch", ctx, d, seen), "sdr_first_touch");
    }
  }
  c.capRemaining = Math.max(0, cap - draftedToday - c.drafted - c.followUps);
  const publicSummary = outreachPublicSummary(c, cap);
  return { summary: `${publicSummary} Skipped: ${c.skippedSuppressed} suppressed, ${c.skippedDuplicate} duplicate, ${c.rejectedByValidator} rejected by validator.`, publicSummary, counts: { ...c } };
}

export async function runOutreachAgent(
  opts: CompanyRunOptions = { trigger: "cron" }, deps: Partial<OutreachDeps> = {},
): Promise<RunResult> {
  const d: OutreachDeps = { store: deps.store ?? drizzleOutreachStore(), generate: deps.generate ?? defaultGenerate, runtime: deps.runtime };
  return runCompanyAgent("outreach", { ...opts, deps: opts.deps ?? d.runtime }, (ctx) => runBody(ctx, d));
}

/**
 * Called from the inbound email handler. Marks a matching lead "replied"; on an opt-out reply, suppresses the
 * address, marks the lead "suppressed" and rejects any pending drafts to it.
 */
export async function recordProspectReply(
  fromEmail: string, text: string, store: OutreachStore = drizzleOutreachStore(),
): Promise<{ matched: boolean; optedOut: boolean }> {
  const email = fromEmail.trim().toLowerCase();
  const lead = await store.matchLeadByEmail(email);
  if (!lead) return { matched: false, optedOut: false };
  const optedOut = isOptOut(text);
  if (optedOut) {
    await store.suppress(email);
    await store.setLead(lead.id, { status: "suppressed" });
    await store.rejectPendingDrafts(email);
  } else {
    await store.setLead(lead.id, { status: "replied" });
  }
  return { matched: true, optedOut };
}
