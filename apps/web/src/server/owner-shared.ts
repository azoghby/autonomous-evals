import "server-only";
/**
 * Agent-owner autopilot: DB-backed helpers shared by submission, lifecycle, responder and outreach.
 * Every email to an owner goes through sendOwnerEmail (suppression + cadence + log + thread mapping).
 */
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { isEmailConfigured, sendEmail, type SentEmail } from "@ae/core/auth/email";
import { decrypt } from "@ae/core/storage/crypto";
import { NON_TRANSACTIONAL_GAP_MS, decideOwnerEmail, ownerFooter, unsubscribeToken, type OwnerEmailDecision } from "./owner-policy";

export const appUrl = (): string => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const companyAddress = (): string => process.env.COMPANY_ADDRESS?.trim() || "[physical mailing address: set COMPANY_ADDRESS]";
export const unsubscribeUrl = (email: string): string => `${appUrl()}/api/leaderboard/unsubscribe?t=${encodeURIComponent(unsubscribeToken(email))}`;
export const footerFor = (agentName: string, email: string): string =>
  ownerFooter({ agentName, unsubscribeUrl: unsubscribeUrl(email), companyAddress: companyAddress() });

export type PublicAgentRow = typeof schema.publicAgents.$inferSelect;

export async function isSuppressed(email: string): Promise<boolean> {
  const s = schema.contactSuppressions;
  const [row] = await db().select({ id: s.id }).from(s).where(sql`lower(${s.email}) = ${email.trim().toLowerCase()}`).limit(1);
  return !!row;
}

export async function suppressEmail(email: string, reason = "opt_out"): Promise<void> {
  await db().insert(schema.contactSuppressions).values({ email: email.trim().toLowerCase(), reason }).onConflictDoNothing();
}

export async function lastNonTransactionalAt(email: string, now: Date): Promise<Date | null> {
  const l = schema.ownerEmailLog;
  const [row] = await db().select({ sentAt: l.sentAt }).from(l)
    .where(and(eq(l.ownerEmail, email.trim().toLowerCase()), eq(l.transactional, false), gt(l.sentAt, new Date(now.getTime() - NON_TRANSACTIONAL_GAP_MS))))
    .orderBy(desc(l.sentAt)).limit(1);
  return row ? new Date(row.sentAt) : null;
}

export interface OwnerEmailInput {
  agent: Pick<PublicAgentRow, "id" | "name" | "ownerEmail">;
  kind: string;
  transactional: boolean;
  subject: string;
  /** Body WITHOUT footer; the honest-sender + unsubscribe + address footer is appended here. */
  text: string;
  now?: Date;
}
export type OwnerEmailResult = { status: Exclude<OwnerEmailDecision, "send"> | "not_configured" | "no_owner" } | { status: "sent"; sent: SentEmail };

/** Suppression and cadence checked before EVERY send; logs to owner_email_log and maps the thread to the agent. */
export async function sendOwnerEmail(i: OwnerEmailInput): Promise<OwnerEmailResult> {
  const to = i.agent.ownerEmail?.trim().toLowerCase();
  if (!to) return { status: "no_owner" };
  if (!isEmailConfigured()) return { status: "not_configured" };
  const now = i.now ?? new Date();
  const decision = decideOwnerEmail({
    transactional: i.transactional, suppressed: await isSuppressed(to),
    lastNonTransactionalAt: i.transactional ? null : await lastNonTransactionalAt(to, now), now,
  });
  if (decision !== "send") return { status: decision };
  const sent = await sendEmail({
    to, subject: i.subject, text: `${i.text}\n\n${footerFor(i.agent.name, to)}`, purpose: "commercial", labels: ["owner_agent", i.kind],
    headers: { "List-Unsubscribe": `<${unsubscribeUrl(to)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  });
  await recordOwnerEmail({ to, agentId: i.agent.id, kind: i.kind, transactional: i.transactional, sent });
  return { status: "sent", sent };
}

export async function recordOwnerEmail(i: { to: string; agentId: string; kind: string; transactional: boolean; sent: SentEmail }): Promise<void> {
  try {
    await db().insert(schema.ownerEmailLog).values({
      ownerEmail: i.to.toLowerCase(), agentId: i.agentId, kind: i.kind, transactional: i.transactional, messageId: i.sent.id,
    });
    if (i.sent.threadId) {
      await db().insert(schema.emailThreads).values({ threadId: i.sent.threadId, purpose: "owner_agent", publicAgentId: i.agentId }).onConflictDoNothing();
    }
  } catch (err) {
    console.error("owner email bookkeeping failed", i.agentId, err instanceof Error ? err.message : err);
  }
}

/** Decrypts the owner's key for a run. Never log the return value. */
export function ownerAgentApiKey(agent: Pick<PublicAgentRow, "apiKeyCiphertext">): string | undefined {
  return agent.apiKeyCiphertext ? decrypt(agent.apiKeyCiphertext) : undefined;
}

export async function getAgentById(id: string): Promise<PublicAgentRow | undefined> {
  const [row] = await db().select().from(schema.publicAgents).where(eq(schema.publicAgents.id, id)).limit(1);
  return row;
}
