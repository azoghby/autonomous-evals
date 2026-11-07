/**
 * Thin adapter from the published Naïve SDK (@usenaive-sdk/managed-agents, verified against 0.12.3)
 * to the NaiveSessionsPort used by the session service. This is the only file that imports the SDK.
 *
 * Facts from the SDK types and API docs this relies on:
 * - `sessions.create(body, { idempotencyKey })` sends an `idempotency-key` header.
 * - Keys never expire; same key + same body replays the original response; a different body is
 *   409 `idempotency_conflict`; an in-flight duplicate is also 409; a non-2xx releases the key.
 * - A 2xx body the SDK cannot parse throws `ResponseParseError` (a subclass of `ApiError`).
 * - `structured_output` is populated only when the session goes idle satisfying `output_schema`.
 */
import { ApiError, createClient, ResponseParseError, type VettaClient } from "@usenaive-sdk/managed-agents";
import {
  NaiveCallError,
  type NaiveSessionCreateBody,
  type NaiveSessionSnapshot,
  type NaiveSessionsPort,
} from "../evals/types";

type SdkSession = Awaited<ReturnType<VettaClient["sessions"]["get"]>>;

/** The subset of the SDK client the adapter needs (lets tests inject a fake). */
export interface NaiveSdkSessions {
  sessions: Pick<VettaClient["sessions"], "create" | "get" | "list">;
}

export interface NaiveClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Deadline per HTTP request. A timed-out create is treated as ambiguous, never as "not created". */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** Creates a real SDK client whose every request has a deadline. The key stays inside the client. */
export function createNaiveClient(options: NaiveClientOptions): VettaClient {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fetchWithTimeout: typeof globalThis.fetch = (input, init) =>
    baseFetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  return createClient({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    fetch: fetchWithTimeout,
  });
}

export function toSnapshot(s: SdkSession): NaiveSessionSnapshot {
  const usage = s.token_usage as Record<string, number> | undefined;
  return {
    id: s.id,
    agentId: s.agent_id,
    agentVersion: s.agent_version,
    status: s.status,
    stopReason: s.stop_reason ?? null,
    stopCode: s.stop_code ?? null,
    structuredOutput: (s.structured_output as Record<string, unknown> | null) ?? null,
    budgetMicroUsd: s.budget_micro_usd,
    consumedMicroUsd: s.consumed_micro_usd,
    tokenUsage: usage ? { ...usage } : {},
    metadata: (s.metadata as Record<string, unknown>) ?? {},
  };
}

export function classifyNaiveError(error: unknown): NaiveCallError {
  if (error instanceof NaiveCallError) return error;
  // Must precede the ApiError check: ResponseParseError extends ApiError but means "2xx we could not read".
  if (error instanceof ResponseParseError) {
    return new NaiveCallError("ambiguous", "unreadable 2xx response", error.status, error.code, error.requestId);
  }
  if (error instanceof ApiError) {
    if (error.status === 429) return new NaiveCallError("rate_limited", error.message, 429, error.code, error.requestId);
    if (error.status === 409 && error.code === "idempotency_conflict") {
      return new NaiveCallError("in_flight", error.message, 409, error.code, error.requestId);
    }
    if (error.status >= 500) return new NaiveCallError("ambiguous", error.message, error.status, error.code, error.requestId);
    return new NaiveCallError("definitive", error.message, error.status, error.code, error.requestId);
  }
  const name = error instanceof Error ? error.name : "unknown";
  return new NaiveCallError("ambiguous", `transport failure (${name})`);
}

export function createNaiveSessionsPort(client: NaiveSdkSessions): NaiveSessionsPort {
  return {
    async createSession(body: NaiveSessionCreateBody, idempotencyKey: string) {
      try {
        return toSnapshot(await client.sessions.create(body, { idempotencyKey }));
      } catch (error) {
        throw classifyNaiveError(error);
      }
    },
    async getSession(sessionId: string) {
      try {
        return toSnapshot(await client.sessions.get(sessionId));
      } catch (error) {
        throw classifyNaiveError(error);
      }
    },
    async listAgentSessions(agentId, page) {
      try {
        const res = await client.sessions.list({ agent_id: agentId, limit: page.limit, after: page.after });
        return { data: res.data.map((s) => toSnapshot(s as SdkSession)), nextCursor: res.next_cursor };
      } catch (error) {
        throw classifyNaiveError(error);
      }
    },
  };
}
