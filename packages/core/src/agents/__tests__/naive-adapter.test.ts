// FIXTURE tests: the real published SDK client with an injected fetch (no network). Not live validation.
import { ApiError, createClient } from "@usenaive-sdk/managed-agents";
import { describe, expect, it } from "vitest";
import { NaiveCallError } from "../../evals/types";
import { classifyNaiveError, createNaiveSessionsPort } from "../naive-adapter";

const session = (over: Record<string, unknown> = {}) => ({
  id: "ses_0abcdefghjkmnpqrstvwxyz123",
  object: "session",
  agent_id: "agt_0abcdefghjkmnpqrstvwxyz123",
  agent_version: 2,
  deployment_id: null,
  identity_id: null,
  computer_id: null,
  parent_session_id: null,
  root_session_id: null,
  thread_role: null,
  model: "m",
  mode: "build",
  status: "idle",
  stop_reason: "end_turn",
  stop_code: null,
  window: "immediate",
  budget_micro_usd: 100_000,
  consumed_micro_usd: 4_321,
  token_usage: { input: 10, cache_write: 0, cache_read: 0, output: 5, reasoning: 0 },
  pending_actions: [],
  output_schema: { type: "object", properties: { ok: { type: "boolean" } } },
  structured_output: { ok: true },
  last_seq: 7,
  metadata: { ae_task_key: "k" },
  started_at: "2026-11-07T20:00:00.000Z",
  ended_at: "2026-11-07T20:00:05.000Z",
  created_at: "2026-11-07T20:00:00.000Z",
  ...over,
});

function fetchReturning(status: number, body: unknown, seen: Array<{ url: string; init: RequestInit }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "req_1" } });
  }) as typeof fetch;
}

const body = {
  agent_id: "agt_1",
  message: "hi",
  budget_micro_usd: 100_000,
  output_schema: { type: "object", properties: { ok: { type: "boolean" } } },
  structured_output_required: true as const,
  metadata: { ae_task_key: "k" },
};

describe("Naïve adapter over the real SDK client", () => {
  it("sends our idempotency key and body, and maps the session", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const client = createClient({ apiKey: "test-key-not-real", baseUrl: "https://naive.invalid", fetch: fetchReturning(200, session(), seen) });
    const snap = await createNaiveSessionsPort(client).createSession(body, "ae-test-abc");
    expect(seen[0]!.url).toBe("https://naive.invalid/v1/sessions");
    const headers = new Headers(seen[0]!.init.headers);
    expect(headers.get("idempotency-key")).toBe("ae-test-abc");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(body);
    expect(snap).toMatchObject({ id: "ses_0abcdefghjkmnpqrstvwxyz123", status: "idle", stopReason: "end_turn", consumedMicroUsd: 4_321, structuredOutput: { ok: true } });
  });

  it("forwards an exact advisory outcome ID through SDK 0.12.3", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const client = createClient({ apiKey: "test-key-not-real", baseUrl: "https://naive.invalid", fetch: fetchReturning(200, session(), seen) });
    const request = { ...body, outcome: "ocm_00000000000000000000000000" };
    await createNaiveSessionsPort(client).createSession(request, "outcome-request");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(request);
  });

  it("classifies API errors by what they mean for creation", async () => {
    const err = (status: number, code: string) => new ApiError(status, { type: "x", code, message: code, request_id: "r" });
    expect(classifyNaiveError(err(400, "validation_failed")).kind).toBe("definitive");
    expect(classifyNaiveError(err(429, "rate_limited")).kind).toBe("rate_limited");
    expect(classifyNaiveError(err(409, "idempotency_conflict")).kind).toBe("in_flight");
    expect(classifyNaiveError(err(503, "unavailable")).kind).toBe("ambiguous");
    expect(classifyNaiveError(new TypeError("fetch failed")).kind).toBe("ambiguous");
    expect(classifyNaiveError(new DOMException("timeout", "TimeoutError")).kind).toBe("ambiguous");
  });

  it("an unreadable 2xx create is ambiguous (the session may exist)", async () => {
    const client = createClient({ apiKey: "test-key-not-real", baseUrl: "https://naive.invalid", fetch: fetchReturning(200, { id: 5 }, []) });
    const e = await createNaiveSessionsPort(client).createSession(body, "k").catch((x) => x);
    expect(e).toBeInstanceOf(NaiveCallError);
    expect(e.kind).toBe("ambiguous");
  });

  it("a 4xx envelope is definitive", async () => {
    const env = { error: { type: "invalid_request_error", code: "validation_failed", message: "bad", request_id: "r" } };
    const client = createClient({ apiKey: "test-key-not-real", baseUrl: "https://naive.invalid", fetch: fetchReturning(400, env, []) });
    const e = await createNaiveSessionsPort(client).createSession(body, "k").catch((x) => x);
    expect(e).toMatchObject({ kind: "definitive", status: 400, code: "validation_failed" });
  });
});
