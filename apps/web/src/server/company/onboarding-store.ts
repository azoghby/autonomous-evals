import "server-only";
/** Persistence seam for the onboarding agent (onboarding_conversations + customers). */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import type { TranscriptEntry } from "@ae/core/company/onboarding";
import { isSuppressed } from "../owner-shared";

export type ConversationStatus = "collecting" | "building" | "running" | "reported" | "blocked" | "closed";
export type Channel = "email" | "chat";

export interface ConversationRow {
  id: string;
  customerId: string;
  channel: Channel;
  threadId: string | null;
  status: ConversationStatus;
  collected: Record<string, unknown>;
  transcript: TranscriptEntry[];
  environmentId: string | null;
  suiteId: string | null;
  runId: string | null;
  reportedAt: Date | null;
  costMicroUsd: number;
  updatedAt: Date;
}
export type ConversationPatch = Partial<Omit<ConversationRow, "id" | "customerId" | "channel" | "updatedAt">>;
export interface CustomerRow { id: string; email: string; name: string | null }

export interface OnboardingStore {
  /** Null when the customer does not exist or is suppressed. */
  getCustomer(id: string): Promise<CustomerRow | null>;
  getConversation(id: string): Promise<ConversationRow | null>;
  findByThread(threadId: string): Promise<ConversationRow | null>;
  /** Most recent conversation (any status but closed) for the customer on that channel. */
  latestForCustomer(customerId: string, channel: Channel): Promise<ConversationRow | null>;
  create(i: { customerId: string; channel: Channel; threadId?: string | null }): Promise<ConversationRow>;
  update(id: string, patch: ConversationPatch): Promise<void>;
  listByStatus(statuses: ConversationStatus[], limit: number): Promise<ConversationRow[]>;
}

type DbRow = typeof schema.onboardingConversations.$inferSelect;
const toRow = (r: DbRow): ConversationRow => ({
  id: r.id, customerId: r.customerId, channel: r.channel as Channel, threadId: r.threadId, status: r.status as ConversationStatus,
  collected: r.collected, transcript: r.transcript, environmentId: r.environmentId, suiteId: r.suiteId, runId: r.runId,
  reportedAt: r.reportedAt ? new Date(r.reportedAt) : null, costMicroUsd: r.costMicroUsd, updatedAt: new Date(r.updatedAt),
});

export function drizzleOnboardingStore(): OnboardingStore {
  const t = schema.onboardingConversations;
  const one = async (where: ReturnType<typeof eq>) => {
    const [row] = await db().select().from(t).where(where).limit(1);
    return row ? toRow(row) : null;
  };
  return {
    async getCustomer(id) {
      const [c] = await db().select({ id: schema.customers.id, email: schema.customers.email, name: schema.customers.name })
        .from(schema.customers).where(eq(schema.customers.id, id)).limit(1);
      if (!c || (await isSuppressed(c.email))) return null;
      return c;
    },
    getConversation: (id) => one(eq(t.id, id)),
    findByThread: (threadId) => one(eq(t.threadId, threadId)),
    async latestForCustomer(customerId, channel) {
      const [row] = await db().select().from(t)
        .where(and(eq(t.customerId, customerId), eq(t.channel, channel), sql`${t.status} <> 'closed'`)).orderBy(desc(t.updatedAt)).limit(1);
      return row ? toRow(row) : null;
    },
    async create(i) {
      const [row] = await db().insert(t).values({ customerId: i.customerId, channel: i.channel, threadId: i.threadId ?? null }).returning();
      return toRow(row!);
    },
    async update(id, patch) {
      await db().update(t).set({ ...patch, updatedAt: new Date() }).where(eq(t.id, id));
    },
    async listByStatus(statuses, limit) {
      const rows = await db().select().from(t).where(inArray(t.status, statuses)).orderBy(t.updatedAt).limit(limit);
      return rows.map(toRow);
    },
  };
}
