"use client";
import { createContext, useContext } from "react";

/** Wire contract: ce4d283, reporting/chat/types.ts and service.ts. Browser-only types. */
export interface ChatReply {
  asOf: string;
  topic: "progress" | "cost" | "findings" | "blockers" | "overview" | "unknown";
  text: string;
  evidenceRefs: string[];
  unknowns: string[];
}
export interface ChatExchange {
  messageId: string;
  inputDigest: string;
  sequence: number;
  reply: ChatReply;
}
/** Optional extension: only emit from persisted, authorized activity records, never inferred prose. */
export interface ChatActivity {
  kind: "acquiring_data" | "waiting_for_expert";
  asOf: string;
  evidenceRefs: string[];
}
export interface ChatPoll {
  cursor: string;
  changed: boolean;
  asOf: string;
  reply?: ChatReply;
  activity?: ChatActivity;
}
export interface ProgressChatTransport {
  /** Verified session UI lifetime key; never an authorization credential or request field. */
  readonly authScopeKey: string;
  history(input: { jobId: string; afterSequence: number; limit: number }, signal: AbortSignal): Promise<{ messages: ChatExchange[]; nextAfterSequence: number }>;
  send(input: { jobId: string; messageId: string; question: string }, signal: AbortSignal): Promise<ChatExchange>;
  poll(input: { jobId: string; cursor?: string }, signal: AbortSignal): Promise<ChatPoll>;
}
export class ProgressChatError extends Error {
  constructor(public readonly code: "unauthenticated" | "not_found" | "invalid_input" | "conflict" | "unavailable") {
    super(code);
  }
}
/**
 * Track A injection seam. Mount this provider in the authenticated client shell
 * only after handlers, durable caller-private storage and safe projection exist.
 * Replace its value on verified session changes; authScopeKey remounts the panel.
 * Adapters validate responses, normalize errors, honor AbortSignal and use
 * same-origin credentials + no-store. No browser subject ID is an access grant.
 * Never connect the workflow-resuming clarification /messages route here.
 */
const ProgressChatContext = createContext<ProgressChatTransport | undefined>(undefined);
export const ProgressChatTransportProvider = ProgressChatContext.Provider;
export function useProgressChatTransport(): ProgressChatTransport | undefined {
  return useContext(ProgressChatContext);
}
