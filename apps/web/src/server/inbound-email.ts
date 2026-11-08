import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import type { InboundMessage } from "@ae/core/email/webhook";
import { sendJobEvent } from "@/workflows/events";
import { respondToOwner } from "./owner-responder";
import { findFounderThread, founderReplyDeps } from "./notify/founder-email";
import { authAllows, resolveFounderEmail } from "./notify/founder-email-logic";
import { processFounderReply, type FounderReplyDeps, type FounderThreadRef } from "./notify/founder-email-reply";

/** Inbound content is untrusted: bounded, stored as data, never interpreted. */
export const MAX_INBOUND_CHARS = 10_000;

export type ThreadRef = { jobId: string | null; expertEngagementId: string | null; publicAgentId?: string | null };

/** Persistence seam so the routing logic is testable without a database. */
export interface InboundStore {
  /** Atomically claims the message id; false if already processed. */
  claim(messageId: string): Promise<boolean>;
  release(messageId: string): Promise<void>;
  findThread(threadId: string): Promise<ThreadRef | null>;
  jobInfo(jobId: string): Promise<{ state: string; customerEmail: string } | null>;
  addCustomerMessage(jobId: string, body: string): Promise<void>;
  expertEmail(engagementId: string): Promise<string | null>;
  /** invited -> replied plus raw response; false if the engagement was not awaiting a reply. */
  recordExpertReply(engagementId: string, raw: string): Promise<boolean>;
  sendClarificationAnswer(jobId: string, answer: string): Promise<void>;
  /** Owner-submitted agent behind a thread: owner address, verification time and lifecycle status. */
  ownerAgent(agentId: string): Promise<{ ownerEmail: string | null; verifiedAt: Date | null; status: string } | null>;
  handleOwnerReply(i: { agentId: string; inboxId: string; messageId: string; body: string }): Promise<"owner_replied" | "owner_escalated">;
  /** Founder email threads we started (approval requests / daily report). Optional so non-founder stores need not implement it. */
  founderThread?(threadId: string): Promise<FounderThreadRef | null>;
  /** Resolved FOUNDER_EMAIL (or first operator), lowercased. */
  founderAddress?(): string | null;
  /** Side effects for an authenticated founder reply, bound to the inbound message. */
  founderReplyDeps?(msg: InboundMessage): FounderReplyDeps;
  /** Signed-up, non-suppressed customer for a sender address. */
  customerByEmail?(email: string): Promise<{ id: string } | null>;
  /** Marks the thread as an onboarding thread so later replies route back. Best-effort. */
  recordOnboardingThread?(threadId: string): Promise<void>;
  handleOnboarding?(i: { customerId: string; threadId: string; inboxId: string; messageId: string; subject: string; body: string }): Promise<void>;
  /** Prospect-lead reply bookkeeping (outreach agent). */
  recordProspectReply?(fromEmail: string, text: string): Promise<{ matched: boolean; optedOut: boolean }>;
}

export type InboundResult =
  | "ignored" | "duplicate" | "unmatched" | "sender_mismatch" | "job_message" | "clarification_delivered" | "expert_reply" | "expert_reply_skipped"
  | "owner_replied" | "owner_escalated"
  | "founder_decided" | "founder_approved_all" | "founder_note" | "founder_no_target" | "founder_unauthenticated"; | "onboarding" | "prospect_reply";

/** Pulls the bare address out of "Name <a@b.c>" and lowercases it. */
export const bareAddress = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

export async function handleInbound(msg: InboundMessage, store: InboundStore): Promise<InboundResult> {
  if (msg.eventType !== "message.received") return "ignored";
  if (!(await store.claim(msg.messageId))) return "duplicate";
  try {
    const body = msg.text.slice(0, MAX_INBOUND_CHARS);
    const sender = bareAddress(msg.from);

    // Founder replies (email-first approvals): only on a thread we started, from the founder address, with passing auth verdicts.
    const founderThread = store.founderThread ? await store.founderThread(msg.threadId) : null;
    if (founderThread && store.founderReplyDeps) {
      const founder = store.founderAddress?.() ?? null;
      if (!founder || sender !== founder) return "sender_mismatch";
      if (!authAllows(msg.auth)) return "founder_unauthenticated";
      const r = await processFounderReply(
        { threadId: msg.threadId, messageId: msg.messageId, subject: msg.subject, text: body, thread: founderThread },
        store.founderReplyDeps(msg),
      );
      return r === "decided" ? "founder_decided" : r === "approved_all" ? "founder_approved_all" : r === "note" ? "founder_note" : "founder_no_target";
    }

    const thread = await store.findThread(msg.threadId);
    const known = !!thread && !!(thread.jobId || thread.expertEngagementId || thread.publicAgentId);
    if (!known) return routeUnknownThread(msg, body, sender, store);
    if (!thread) return "unmatched";

    if (thread.jobId) {
      const job = await store.jobInfo(thread.jobId);
      if (!job) return "unmatched";
      if (job.customerEmail.toLowerCase() !== sender) return "sender_mismatch";
      await store.addCustomerMessage(thread.jobId, body);
      if (job.state === "needs_clarification") {
        await store.sendClarificationAnswer(thread.jobId, body);
        return "clarification_delivered";
      }
      return "job_message";
    }
    if (thread.expertEngagementId) {
      const expected = await store.expertEmail(thread.expertEngagementId);
      if (!expected || expected.toLowerCase() !== sender) return "sender_mismatch";
      return (await store.recordExpertReply(thread.expertEngagementId, body)) ? "expert_reply" : "expert_reply_skipped";
    }
    if (thread.publicAgentId) {
      const owner = await store.ownerAgent(thread.publicAgentId);
      if (!owner) return "unmatched";
      if (!owner.ownerEmail || !owner.verifiedAt || bareAddress(owner.ownerEmail) !== sender) return "sender_mismatch";
      return store.handleOwnerReply({ agentId: thread.publicAgentId, inboxId: msg.inboxId, messageId: msg.messageId, body });
    }
    return "unmatched";
  } catch (err) {
    await store.release(msg.messageId); // let AgentMail's retry reprocess it
    throw err;
  }
}

/**
 * Messages not on a job / engagement / public-agent thread: prospect replies (outreach bookkeeping) and signed-up
 * customers writing to us (onboarding agent). Unknown senders are unchanged: "unmatched".
 */
async function routeUnknownThread(msg: InboundMessage, body: string, sender: string, store: InboundStore): Promise<InboundResult> {
  let prospect = false;
  if (store.recordProspectReply) {
    try { prospect = (await store.recordProspectReply(sender, body)).matched; }
    catch (err) { console.error("recordProspectReply failed", err instanceof Error ? err.message : err); }
  }
  const customer = store.customerByEmail ? await store.customerByEmail(sender) : null;
  if (customer && store.handleOnboarding) {
    await store.recordOnboardingThread?.(msg.threadId);
    await store.handleOnboarding({ customerId: customer.id, threadId: msg.threadId, inboxId: msg.inboxId, messageId: msg.messageId, subject: msg.subject, body });
    return "onboarding";
  }
  return prospect ? "prospect_reply" : "unmatched";
}

/** Idempotency rides on the idempotency_keys table (key agentmail:<messageId>). */
export function drizzleInboundStore(): InboundStore {
  const d = () => db();
  return {
    async claim(messageId) {
      const rows = await d().insert(schema.idempotencyKeys)
        .values({ key: `agentmail:${messageId}`, scope: "agentmail" }).onConflictDoNothing().returning({ key: schema.idempotencyKeys.key });
      return rows.length > 0;
    },
    async release(messageId) {
      await d().delete(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, `agentmail:${messageId}`));
    },
    async findThread(threadId) {
      const [row] = await d().select({ jobId: schema.emailThreads.jobId, expertEngagementId: schema.emailThreads.expertEngagementId, publicAgentId: schema.emailThreads.publicAgentId })
        .from(schema.emailThreads).where(eq(schema.emailThreads.threadId, threadId)).limit(1);
      return row ?? null;
    },
    async jobInfo(jobId) {
      const [row] = await d().select({ state: schema.jobs.state, customerEmail: schema.customers.email })
        .from(schema.jobs).innerJoin(schema.customers, eq(schema.jobs.customerId, schema.customers.id))
        .where(eq(schema.jobs.id, jobId)).limit(1);
      return row ?? null;
    },
    async addCustomerMessage(jobId, body) {
      await d().insert(schema.messages).values({ jobId, role: "customer", body });
    },
    async expertEmail(engagementId) {
      const [row] = await d().select({ email: schema.experts.email }).from(schema.expertEngagements)
        .innerJoin(schema.experts, eq(schema.experts.id, schema.expertEngagements.expertId))
        .where(eq(schema.expertEngagements.id, engagementId)).limit(1);
      return row?.email ?? null;
    },
    async recordExpertReply(engagementId, raw) {
      const claimed = await d().update(schema.expertEngagements).set({ status: "replied", answeredAt: new Date() })
        .where(and(eq(schema.expertEngagements.id, engagementId), eq(schema.expertEngagements.status, "invited")))
        .returning({ id: schema.expertEngagements.id });
      if (claimed.length === 0) return false;
      await d().insert(schema.expertResponses).values({
        engagementId, answers: { raw, via: "email" }, provenance: "expert_sourced",
      });
      return true;
    },
    async sendClarificationAnswer(jobId, answer) {
      await sendJobEvent(jobId, { type: "clarification_answer", answer });
    },
    async ownerAgent(agentId) {
      const a = schema.publicAgents;
      const [row] = await d().select({ ownerEmail: a.ownerEmail, verifiedAt: a.verifiedAt, status: a.status }).from(a).where(eq(a.id, agentId)).limit(1);
      return row ? { ownerEmail: row.ownerEmail, verifiedAt: row.verifiedAt ? new Date(row.verifiedAt) : null, status: row.status } : null;
    },
    handleOwnerReply: (i) => respondToOwner(i),
    founderThread: (threadId) => findFounderThread(threadId),
    founderAddress: () => resolveFounderEmail(),
    founderReplyDeps: (msg) => founderReplyDeps(msg),
    async customerByEmail(email) {
      const [row] = await d().select({ id: schema.customers.id }).from(schema.customers)
        .where(sql`lower(${schema.customers.email}) = ${email}`).limit(1);
      if (!row) return null;
      const { isSuppressed } = await import("./owner-shared");
      return (await isSuppressed(email)) ? null : row;
    },
    async recordOnboardingThread(threadId) {
      const { recordEmailThread } = await import("./email-threads");
      await recordEmailThread(threadId, "onboarding", {});
    },
    async handleOnboarding(i) {
      const { handleOnboardingMessage } = await import("./company/onboarding");
      await handleOnboardingMessage({ customerId: i.customerId, channel: "email", text: i.body, threadId: i.threadId, subject: i.subject, inboxId: i.inboxId, messageId: i.messageId });
    },
    async recordProspectReply(fromEmail, text) {
      const { recordProspectReply } = await import("./company/outreach");
      return recordProspectReply(fromEmail, text);
    },
  };
}
