/**
 * Founder-approval handler registry, keyed by approval kind. Dependency-free so any module can register
 * without import cycles. Built-in kinds live in ./handlers.ts; see docs/FOUNDER_APPROVALS.md.
 */
import type { DecidedVia, Decision } from "./types";

export interface ApprovalRecord {
  id: string; seq: number; kind: string; title: string; summary: string; ref: string;
  payload: Record<string, unknown>;
}

export interface DecisionContext {
  approval: ApprovalRecord;
  decision: Decision;
  via: DecidedVia;
  /** Operator email the decision is attributed to (the founder, or the console viewer). */
  actor: string;
}

/**
 * ok=false records the error on the approval. By default the approval is put back to pending so it can be retried;
 * revert=false keeps the decision (the underlying action already happened in part, e.g. a draft was approved but its
 * send failed, so a re-decision would not redo it; retry from the console instead).
 */
export interface HandlerResult { ok: boolean; note: string; revert?: boolean }

export interface ApprovalHandler {
  /** Button label for approve, e.g. "Approve & send". */
  approveLabel: string;
  /** Button label for reject, or null when only one action makes sense (e.g. "Mark contacted"). */
  rejectLabel: string | null;
  /** Console path for the View button (default /operator). */
  viewPath?: (a: ApprovalRecord) => string;
  /** Runs exactly once, after the pending -> approved|rejected claim succeeded. Must be idempotent-safe anyway. */
  onDecision: (ctx: DecisionContext) => Promise<HandlerResult>;
}

const handlers = new Map<string, ApprovalHandler>();

export const KIND_RE = /^[a-z][a-z0-9_]{1,47}$/;

export function registerApprovalHandler(kind: string, handler: ApprovalHandler): void {
  if (!KIND_RE.test(kind)) throw new Error(`invalid approval kind "${kind}"`);
  handlers.set(kind, handler);
}

export function getApprovalHandler(kind: string): ApprovalHandler | undefined {
  return handlers.get(kind);
}

export function registeredKinds(): string[] {
  return [...handlers.keys()];
}
