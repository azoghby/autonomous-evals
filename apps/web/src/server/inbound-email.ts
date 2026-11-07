import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import type { InboundMessage } from "@ae/core/email/webhook";
import { sendJobEvent } from "@/workflows/events";

/** Inbound content is untrusted: bounded, stored as data, never interpreted. */
export const MAX_INBOUND_CHARS = 10_000;

export type ThreadRef = { jobId: string | null; expertEngagementId: string | null };

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
}

export type InboundResult =
  | "ignored" | "duplicate" | "unmatched" | "sender_mismatch" | "job_message" | "clarification_delivered" | "expert_reply" | "expert_reply_skipped";

/** Pulls the bare address out of "Name <a@b.c>" and lowercases it. */
export const bareAddress = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

export async function handleInbound(msg: InboundMessage, store: InboundStore): Promise<InboundResult> {
  if (msg.eventType !== "message.received") return "ignored";
  if (!(await store.claim(msg.messageId))) return "duplicate";
  try {
    const body = msg.text.slice(0, MAX_INBOUND_CHARS);
    const thread = await store.findThread(msg.threadId);
    if (!thread) return "unmatched";
    const sender = bareAddress(msg.from);

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
    return "unmatched";
  } catch (err) {
    await store.release(msg.messageId); // let AgentMail's retry reprocess it
    throw err;
  }
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
      const [row] = await d().select({ jobId: schema.emailThreads.jobId, expertEngagementId: schema.emailThreads.expertEngagementId })
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
  };
}
