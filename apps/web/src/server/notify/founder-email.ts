import "server-only";
import { desc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { replyInThread } from "@ae/core/email/agentmail";
import type { InboundMessage } from "@ae/core/email/webhook";
import { approveAndSendDraft } from "../outreach-approve";
import { DIGEST_MAX_DRAFTS } from "../operator-digest";
import { decideApproval } from "./approvals";
import { resolveFounderEmail, type FounderNote } from "./founder-email-logic";
import type { FounderReplyDeps, FounderThreadRef } from "./founder-email-reply";

/** Remembers a thread we started so a later reply on it can be trusted as ours. Best-effort: never fails the send. */
export async function recordFounderThread(threadId: string | null | undefined, kind: "approval" | "report", approvalId?: string): Promise<void> {
  if (!threadId) return;
  try {
    await db().insert(schema.founderEmailThreads).values({ threadId, kind, approvalId: approvalId ?? null }).onConflictDoNothing();
  } catch (err) {
    console.error("recordFounderThread failed", err instanceof Error ? err.message : err);
  }
}

export async function findFounderThread(threadId: string): Promise<FounderThreadRef | null> {
  const t = schema.founderEmailThreads, a = schema.founderApprovals;
  const [row] = await db().select({ kind: t.kind, seq: a.seq }).from(t).leftJoin(a, eq(a.id, t.approvalId)).where(eq(t.threadId, threadId)).limit(1);
  return row ? { kind: row.kind === "report" ? "report" : "approval", approvalSeq: row.seq ?? null } : null;
}

export function founderReplyDeps(msg: InboundMessage): FounderReplyDeps {
  const actor = resolveFounderEmail() ?? "founder";
  return {
    async decide(seq, decision) {
      const r = await decideApproval({ seq, decision, via: "email_reply", actor });
      return { ok: r.ok, message: r.message };
    },
    async approveAllDrafts() {
      const d = schema.outreachDrafts;
      const ids = (await db().select({ id: d.id }).from(d).where(eq(d.status, "pending")).limit(DIGEST_MAX_DRAFTS)).map((r) => r.id);
      let sent = 0, approved = 0, skipped = 0;
      for (const id of ids) {
        const r = await approveAndSendDraft(id, actor);
        if (!r.ok) skipped++; else if (r.status === "sent") sent++; else approved++;
      }
      if (ids.length > 0) {
        await db().insert(schema.interventions).values({
          operatorEmail: actor, kind: "founder_decision",
          note: `approve_all via email_reply: ${ids.length} drafts (${sent} sent, ${approved} approved, ${skipped} skipped)`,
        }).catch((err) => console.error("approve-all audit failed", err instanceof Error ? err.message : err));
      }
      return { total: ids.length, sent, approved, skipped };
    },
    async saveNote(n) {
      await db().insert(schema.founderNotes).values(n).onConflictDoNothing();
    },
    async reply(text) {
      try { await replyInThread(msg.inboxId, msg.messageId, { text, labels: ["founder-reply"] }); }
      catch (err) { console.error("founder confirmation reply failed", err instanceof Error ? err.message : err); }
    },
  };
}

const toNote = (r: typeof schema.founderNotes.$inferSelect): FounderNote => ({ id: r.id, body: r.body, createdAt: r.createdAt, approvalSeq: r.approvalSeq });

export async function listFounderNotes(limit = 50) {
  const rows = await db().select().from(schema.founderNotes).orderBy(desc(schema.founderNotes.createdAt)).limit(limit);
  return rows.map((r) => ({ ...toNote(r), createdAt: r.createdAt.toISOString(), reportedAt: r.reportedAt?.toISOString() ?? null }));
}

export async function unreportedFounderNotes(limit = 50): Promise<FounderNote[]> {
  const n = schema.founderNotes;
  return (await db().select().from(n).where(isNull(n.reportedAt)).orderBy(n.createdAt).limit(limit)).map(toNote);
}

export async function markNotesReported(ids: string[], now = new Date()): Promise<void> {
  if (ids.length === 0) return;
  await db().update(schema.founderNotes).set({ reportedAt: now }).where(inArray(schema.founderNotes.id, ids));
}
