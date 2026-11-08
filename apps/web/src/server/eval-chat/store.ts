/** Eval copilot persistence: one thread per (owner, eval) + proposed actions. Every query is owner-scoped. */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import type { ActionKind, ActionStatus, EvalRef, EvalUIMessage } from "@/lib/eval-chat/types";

export interface ActionRow {
  id: string; ownerId: string; evalKind: string; evalId: string; kind: ActionKind;
  payload: Record<string, unknown>; status: ActionStatus; result: Record<string, unknown> | null; expiresAt: Date; createdAt: Date;
}

export interface EvalChatStore {
  loadMessages(ownerId: string, ref: EvalRef, limit?: number): Promise<EvalUIMessage[]>;
  saveMessages(ownerId: string, ref: EvalRef, messages: EvalUIMessage[]): Promise<void>;
  createAction(row: Omit<ActionRow, "status" | "result" | "createdAt">): Promise<ActionRow>;
  getAction(ownerId: string, ref: EvalRef, id: string): Promise<ActionRow | null>;
  /** Compare-and-set: only moves from `from`; returns null when another request got there first. */
  transitionAction(id: string, from: ActionStatus, to: ActionStatus, result?: Record<string, unknown>): Promise<ActionRow | null>;
  listActions(ownerId: string, ref: EvalRef): Promise<ActionRow[]>;
}

const M = schema.evalChatMessages;
const A = schema.evalChatActions;
const thread = (t: typeof M | typeof A, ownerId: string, ref: EvalRef) => and(eq(t.ownerId, ownerId), eq(t.evalKind, ref.kind), eq(t.evalId, ref.id));
const toAction = (r: typeof A.$inferSelect): ActionRow => ({ ...r, kind: r.kind as ActionKind, status: r.status as ActionStatus, result: r.result ?? null });

export function createDbEvalChatStore(): EvalChatStore {
  return {
    async loadMessages(ownerId, ref, limit = 80) {
      const rows = await db().select({ message: M.message }).from(M).where(thread(M, ownerId, ref)).orderBy(desc(M.createdAt)).limit(limit);
      return rows.reverse().map((r) => r.message as unknown as EvalUIMessage);
    },
    async saveMessages(ownerId, ref, messages) {
      if (!messages.length) return;
      const base = Date.now();
      await db().insert(M).values(messages.map((m, i) => ({
        id: m.id, ownerId, evalKind: ref.kind, evalId: ref.id, role: m.role, message: m as unknown as Record<string, unknown>,
        createdAt: new Date(base + i),
      }))).onConflictDoUpdate({ target: M.id, set: { message: sql`excluded.message` }, setWhere: thread(M, ownerId, ref) });
    },
    async createAction(row) {
      const [r] = await db().insert(A).values({ ...row, status: "proposed" }).returning();
      return toAction(r);
    },
    async getAction(ownerId, ref, id) {
      const [r] = await db().select().from(A).where(and(thread(A, ownerId, ref), eq(A.id, id))).limit(1);
      return r ? toAction(r) : null;
    },
    async transitionAction(id, from, to, result) {
      const [r] = await db().update(A).set({ status: to, ...(result ? { result } : {}), updatedAt: new Date() })
        .where(and(eq(A.id, id), eq(A.status, from))).returning();
      return r ? toAction(r) : null;
    },
    async listActions(ownerId, ref) {
      return (await db().select().from(A).where(thread(A, ownerId, ref)).orderBy(asc(A.createdAt)).limit(200)).map(toAction);
    },
  };
}

/** In-memory store for tests. */
export function createMemoryEvalChatStore(): EvalChatStore & { messages: Map<string, { ownerId: string; ref: EvalRef; m: EvalUIMessage }>; actions: Map<string, ActionRow> } {
  const messages = new Map<string, { ownerId: string; ref: EvalRef; m: EvalUIMessage }>();
  const actions = new Map<string, ActionRow>();
  const same = (a: EvalRef, b: EvalRef) => a.kind === b.kind && a.id === b.id;
  return {
    messages, actions,
    async loadMessages(ownerId, ref, limit = 80) {
      return [...messages.values()].filter((x) => x.ownerId === ownerId && same(x.ref, ref)).map((x) => x.m).slice(-limit);
    },
    async saveMessages(ownerId, ref, ms) {
      for (const m of ms) {
        const prev = messages.get(m.id);
        if (prev && prev.ownerId !== ownerId) continue;
        messages.set(m.id, { ownerId, ref, m });
      }
    },
    async createAction(row) {
      const r: ActionRow = { ...row, status: "proposed", result: null, createdAt: new Date() };
      actions.set(r.id, r);
      return r;
    },
    async getAction(ownerId, ref, id) {
      const r = actions.get(id);
      return r && r.ownerId === ownerId && r.evalKind === ref.kind && r.evalId === ref.id ? r : null;
    },
    async transitionAction(id, from, to, result) {
      const r = actions.get(id);
      if (!r || r.status !== from) return null;
      const next = { ...r, status: to, result: result ?? r.result };
      actions.set(id, next);
      return next;
    },
    async listActions(ownerId, ref) {
      return [...actions.values()].filter((r) => r.ownerId === ownerId && r.evalKind === ref.kind && r.evalId === ref.id);
    },
  };
}
