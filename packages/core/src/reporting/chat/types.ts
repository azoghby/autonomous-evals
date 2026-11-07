import { z } from "zod";

/** Limits are part of the adapter contract, including persisted reads. */
export const CHAT_LIMITS = {
  inputCharacters: 4_000,
  inputBytes: 8_000,
  historyPage: 50,
  milestones: 200,
  findings: 200,
  blockers: 50,
  costs: 1_000,
} as const;

/** Public references are opaque record IDs, never URLs, excerpts, prompts or bodies. */
export const ChatReferenceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const timestamp = z.iso.datetime({ offset: true });
const identity = z.string().min(1).max(256);
export const AuthenticatedCallerSchema = z.object({ subjectId: identity }).strict();
export type AuthenticatedCaller = z.infer<typeof AuthenticatedCallerSchema>;
export const ChatScopeSchema = z.object({ subjectId: identity, jobId: ChatReferenceSchema }).strict();
export type ChatScope = z.infer<typeof ChatScopeSchema>;

export const ProgressSnapshotSchema = z.object({
  jobId: ChatReferenceSchema,
  /** Timestamp of the persisted projection, not the time this request was answered. */
  observedAt: timestamp,
  status: z.enum([
    "draft", "needs_clarification", "quoted", "awaiting_payment", "planning", "running",
    "investigating", "delivered", "payment_review", "paused_budget", "failed", "cancelled",
  ]),
  statusEvidenceRef: ChatReferenceSchema,
  milestones: z.array(z.object({
    id: ChatReferenceSchema,
    milestone: z.enum(["planning", "running", "investigating", "delivered", "other"]),
    at: timestamp,
    evidenceRef: ChatReferenceSchema,
  }).strict()).max(CHAT_LIMITS.milestones),
  findings: z.array(z.object({
    id: ChatReferenceSchema,
    status: z.enum(["confirmed", "rubric_concern", "inconclusive"]),
    severity: z.enum(["critical", "high", "medium", "low"]),
    evidenceRefs: z.array(ChatReferenceSchema).min(1).max(20),
  }).strict()).max(CHAT_LIMITS.findings),
  blockers: z.array(z.object({
    id: ChatReferenceSchema,
    kind: z.enum(["budget", "payment", "input", "provider", "other"]),
    evidenceRef: ChatReferenceSchema,
  }).strict()).max(CHAT_LIMITS.blockers),
  costs: z.array(z.object({
    id: ChatReferenceSchema,
    source: z.enum(["naive", "ai_gateway"]),
    microUsd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    evidenceRef: ChatReferenceSchema,
  }).strict()).max(CHAT_LIMITS.costs),
  unknownCosts: z.boolean(),
}).strict();
export type ProgressSnapshot = z.infer<typeof ProgressSnapshotSchema>;

export const ChatReplySchema = z.object({
  asOf: timestamp,
  topic: z.enum(["progress", "cost", "findings", "blockers", "overview", "unknown"]),
  text: z.string().min(1).max(32_000),
  evidenceRefs: z.array(ChatReferenceSchema).max(6_000),
  unknowns: z.array(z.string().min(1).max(500)).max(20),
}).strict();
export type ChatReply = z.infer<typeof ChatReplySchema>;

export const ChatExchangeSchema = z.object({
  messageId: ChatReferenceSchema,
  /** SHA-256 of bounded input. The raw question is intentionally not persisted here. */
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reply: ChatReplySchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type ChatExchange = z.infer<typeof ChatExchangeSchema>;
export const ChatAppendInputSchema = ChatExchangeSchema.omit({ sequence: true });
export type ChatAppendInput = z.infer<typeof ChatAppendInputSchema>;
export const ChatHistoryQuerySchema = z.object({
  afterSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(CHAT_LIMITS.historyPage),
}).strict();
export type ChatHistoryQuery = z.infer<typeof ChatHistoryQuerySchema>;

/** Constructed server-side per request. Neither method takes caller identity from JSON. */
export interface TrustedAccessPort {
  authenticate(): Promise<AuthenticatedCaller | null>;
  resolveAuthorizedJob(caller: AuthenticatedCaller, jobId: string): Promise<ChatScope | null>;
}

/** Return a complete, customer-safe projection from persisted records only. */
export interface ProgressPort {
  read(scope: ChatScope): Promise<ProgressSnapshot>;
}

/**
 * Durable adapters MUST partition every operation by BOTH subjectId and jobId.
 * append atomically assigns a monotonically increasing per-scope sequence and
 * inserts once under UNIQUE(subjectId, jobId, messageId). A racing/replayed
 * append returns the original exchange unchanged, including its inputDigest.
 * list returns ascending sequences strictly greater than afterSequence, bounded
 * by limit. Authorization is checked again by the service before every read.
 */
export interface ConversationPort {
  get(scope: ChatScope, messageId: string): Promise<ChatExchange | null>;
  append(scope: ChatScope, input: ChatAppendInput): Promise<ChatExchange>;
  list(scope: ChatScope, query: ChatHistoryQuery): Promise<ChatExchange[]>;
}

export type ChatErrorCode = "unauthenticated" | "not_found" | "invalid_input" | "conflict" | "invalid_snapshot" | "storage_error";
const errorMessages: Record<ChatErrorCode, string> = {
  unauthenticated: "Authentication required.",
  not_found: "Job not found.",
  invalid_input: "Invalid chat request.",
  conflict: "Message ID was already used with different input.",
  invalid_snapshot: "Persisted progress is unavailable or invalid.",
  storage_error: "Conversation storage is unavailable or invalid.",
};

/** Fixed messages prevent adapter errors from leaking provider bodies or secrets. */
export class ChatError extends Error {
  constructor(public readonly code: ChatErrorCode) {
    super(errorMessages[code]);
    this.name = "ChatError";
  }
}
