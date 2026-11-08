import "server-only";
import { and, desc, eq, lt } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { operatorEmails } from "@ae/core/auth/tokens";
import { redactAlertText } from "../operator-alerts";
import { appUrl } from "../owner-shared";
import { DEFAULT_APPROVAL_TTL_MS, MAX_TITLE_CHARS, noopMessage, phoneSummary, transition } from "./approvals-logic";
import { dispatchApproval, type ChannelResults } from "./channels";
import { markTelegramDecided, telegramConfigured } from "./telegram";
import { getApprovalHandler, KIND_RE, type ApprovalRecord } from "./registry";
import "./handlers"; // registers the built-in kinds (outreach_draft, sales_lead, ...)
import type { ApprovalMessage, DecidedVia, Decision } from "./types";

export { registerApprovalHandler, type ApprovalHandler, type DecisionContext, type HandlerResult } from "./registry";

/**
 * Founder approvals: the one API every gate (outreach, leads, purchases, company agents) uses to put a decision
 * or an FYI on the founder's phone. See docs/FOUNDER_APPROVALS.md.
 *
 *   await requestFounderApproval({ kind: "outreach_draft", title: "Outreach to Acme", summary, ref: draftId });
 *   await requestFounderApproval({ kind: "agent_audit_purchase", title: "Agent Audit bought", summary, ref: purchaseId, fyi: true });
 *
 * Never throws: notification problems must not fail the caller's flow.
 */

export interface FounderApprovalRequest {
  /** Handler kind registered in ./handlers.ts (required unless fyi). */
  kind: string;
  title: string;
  /** Free text; secrets and email addresses are redacted and it is truncated for phones. */
  summary: string;
  /** Stable reference to the thing being approved (e.g. a draft id). (kind, ref) is unique: re-requests are no-ops. */
  ref: string;
  payload?: Record<string, unknown>;
  /** FYI only: no buttons, no decision. */
  fyi?: boolean;
  /** Default 7 days. After this, decisions are refused and the item is marked expired. */
  expiresInMs?: number;
  /** Skip the email fallback (the caller already emails operators, e.g. operator alerts). */
  skipEmail?: boolean;
}

export type FounderApprovalResult =
  | { ok: true; created: boolean; id: string; seq: number; results?: ChannelResults }
  | { ok: false; error: string };

export const founderEmail = (): string => [...operatorEmails()][0] ?? "founder";

function toRecord(r: typeof schema.founderApprovals.$inferSelect): ApprovalRecord {
  return { id: r.id, seq: r.seq, kind: r.kind, title: r.title, summary: r.summary, ref: r.ref, payload: (r.payload ?? {}) as Record<string, unknown> };
}

export function toMessage(a: ApprovalRecord, fyi: boolean): ApprovalMessage {
  const h = getApprovalHandler(a.kind);
  return {
    seq: a.seq, kind: a.kind, title: a.title, summary: a.summary,
    viewUrl: `${appUrl()}${h?.viewPath?.(a) ?? "/operator"}`,
    actions: fyi || !h ? null : { approveLabel: h.approveLabel, rejectLabel: h.rejectLabel },
  };
}

export async function requestFounderApproval(req: FounderApprovalRequest, now = new Date()): Promise<FounderApprovalResult> {
  try {
    if (!KIND_RE.test(req.kind)) return { ok: false, error: `invalid kind "${req.kind}"` };
    const fyi = !!req.fyi;
    if (!fyi && !getApprovalHandler(req.kind)) return { ok: false, error: `no handler registered for kind "${req.kind}"` };
    const t = schema.founderApprovals;
    const [row] = await db().insert(t).values({
      kind: req.kind,
      title: redactAlertText(phoneSummary(req.title, MAX_TITLE_CHARS), MAX_TITLE_CHARS),
      summary: phoneSummary(redactAlertText(req.summary, 2000)),
      ref: req.ref.slice(0, 200),
      payload: req.payload ?? {},
      status: fyi ? "fyi" : "pending",
      expiresAt: fyi ? null : new Date(now.getTime() + (req.expiresInMs ?? DEFAULT_APPROVAL_TTL_MS)),
    }).onConflictDoNothing().returning();
    if (!row) {
      const [existing] = await db().select({ id: t.id, seq: t.seq }).from(t).where(and(eq(t.kind, req.kind), eq(t.ref, req.ref.slice(0, 200)))).limit(1);
      return existing ? { ok: true, created: false, id: existing.id, seq: existing.seq } : { ok: false, error: "insert conflict" };
    }
    const out = await dispatchApproval(toMessage(toRecord(row), fyi), row.id, process.env, { skipEmail: !!req.skipEmail });
    if (out.telegram) await db().update(t).set({ channelRefs: { telegram: out.telegram } }).where(eq(t.id, row.id));
    return { ok: true, created: true, id: row.id, seq: row.seq, results: out.results };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("requestFounderApproval failed", req.kind, error);
    return { ok: false, error };
  }
}

export interface DecideInput {
  id?: string;
  seq?: number;
  decision: Decision;
  via: DecidedVia;
  /** Defaults to the founder (first OPERATOR_EMAILS entry). */
  actor?: string;
}

export interface DecideResult { ok: boolean; changed: boolean; status: string; message: string; seq?: number }

/** Idempotent decision: only a pending, unexpired approval changes, exactly once; everything else is a no-op. */
export async function decideApproval(input: DecideInput, now = new Date()): Promise<DecideResult> {
  const t = schema.founderApprovals;
  const where = input.id ? eq(t.id, input.id) : input.seq !== undefined ? eq(t.seq, input.seq) : null;
  if (!where) return { ok: false, changed: false, status: "invalid", message: "No approval specified." };
  const [row] = await db().select().from(t).where(where).limit(1);
  if (!row) return { ok: false, changed: false, status: "not_found", message: `No approval ${input.seq !== undefined ? `#${input.seq}` : ""} found.`.replace("  ", " ") };

  const tr = transition({ status: row.status, expiresAt: row.expiresAt }, input.decision, now);
  if (tr.kind === "noop") return { ok: true, changed: false, status: row.status, message: noopMessage(tr.reason, row.seq), seq: row.seq };
  if (tr.kind === "expire") {
    await db().update(t).set({ status: "expired" }).where(and(eq(t.id, row.id), eq(t.status, "pending")));
    return { ok: true, changed: false, status: "expired", message: noopMessage("expire", row.seq), seq: row.seq };
  }

  const actor = input.actor ?? founderEmail();
  const [claimed] = await db().update(t)
    .set({ status: tr.to, decidedVia: input.via, decidedBy: actor, decidedAt: now })
    .where(and(eq(t.id, row.id), eq(t.status, "pending"))).returning();
  if (!claimed) {
    const [cur] = await db().select({ status: t.status }).from(t).where(eq(t.id, row.id)).limit(1);
    const reason = cur?.status === "approved" ? "already_approved" : cur?.status === "rejected" ? "already_rejected" : "expired";
    return { ok: true, changed: false, status: cur?.status ?? "unknown", message: noopMessage(reason, row.seq), seq: row.seq };
  }

  const handler = getApprovalHandler(row.kind);
  let note = `${tr.to === "approved" ? "Approved" : "Rejected"} #${row.seq}.`;
  let ok = true;
  if (handler) {
    try {
      const r = await handler.onDecision({ approval: toRecord(claimed), decision: input.decision, via: input.via, actor });
      ok = r.ok; note = r.note;
    } catch (err) {
      ok = false; note = `Handler failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error("approval handler failed", row.kind, row.id, note);
    }
  }
  const result = (ok ? note : `error: ${note}`).slice(0, 500);
  await db().update(t).set({ result }).where(eq(t.id, row.id));
  await db().insert(schema.interventions).values({
    operatorEmail: actor, kind: "founder_decision",
    note: `${tr.to} #${row.seq} [${row.kind}] ${row.title} via ${input.via}: ${result}`.slice(0, 1000),
  }).catch((err) => console.error("founder decision audit failed", err instanceof Error ? err.message : err));

  const tg = (claimed.channelRefs as { telegram?: { chatId: string; messageId: number } } | null)?.telegram;
  if (tg && telegramConfigured()) {
    await markTelegramDecided(tg.chatId, tg.messageId, `${tr.to === "approved" ? "✅" : "❌"} ${note}`.slice(0, 500))
      .catch((err) => console.error("telegram mark decided failed", err instanceof Error ? err.message : err));
  }
  return { ok, changed: true, status: tr.to, message: note, seq: row.seq };
}

/** Marks pending approvals past their expiry as expired. Returns the count. */
export async function expireStaleApprovals(now = new Date()): Promise<number> {
  const t = schema.founderApprovals;
  const rows = await db().update(t).set({ status: "expired" }).where(and(eq(t.status, "pending"), lt(t.expiresAt, now))).returning({ id: t.id });
  return rows.length;
}

export async function listApprovals(limit = 100) {
  const t = schema.founderApprovals;
  const rows = await db().select().from(t).orderBy(desc(t.createdAt)).limit(limit);
  return rows.map((r) => {
    const rec = toRecord(r);
    const msg = toMessage(rec, r.status === "fyi");
    return {
      id: r.id, seq: r.seq, kind: r.kind, title: r.title, summary: r.summary, status: r.status,
      decidedVia: r.decidedVia, decidedBy: r.decidedBy, decidedAt: r.decidedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(), viewUrl: msg.viewUrl,
      approveLabel: msg.actions?.approveLabel ?? null, rejectLabel: msg.actions?.rejectLabel ?? null,
      error: r.result?.startsWith("error:") ? r.result : null,
    };
  });
}

export async function getApprovalById(id: string) {
  const [row] = await db().select().from(schema.founderApprovals).where(eq(schema.founderApprovals.id, id)).limit(1);
  return row ?? null;
}
