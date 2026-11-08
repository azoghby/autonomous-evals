/**
 * Optional Naïve managed-agent runtime for company agents' structured LLM calls.
 * When COMPANY_AGENT_RUNTIME=naive and the role env vars are set, the same prompt is sent to a Naïve session on the
 * mapped pinned role agent and its structured output is validated with the SAME zod schema. ANY failure (missing env,
 * timeout, 429, failed session, schema mismatch) falls back to the existing gateway generator, unchanged.
 */
import type { GatewayContext, GenerateStructuredArgs, StructuredResult } from "@ae/core/ai/gateway";
import type { CompanyAgentId } from "@ae/core/company/registry";
import type { NaiveSessionCreateBody, NaiveSessionSnapshot } from "@ae/core/evals/types";

export type StructuredFn = <T>(args: GenerateStructuredArgs<T>) => Promise<StructuredResult<T>>;

export interface NaiveCompanyClient {
  createSession(body: NaiveSessionCreateBody, idempotencyKey: string): Promise<NaiveSessionSnapshot>;
  getSession(sessionId: string): Promise<NaiveSessionSnapshot>;
}

export interface LlmCallRecord {
  runtime: "naive" | "gateway";
  role?: string;
  sessionId?: string | null;
  fallbackReason?: string;
}

/** GatewayContext plus an optional call log the company runtime attaches (not part of the core type). */
export type CompanyGatewayContext = GatewayContext & { logLlmCall?: (r: LlmCallRecord) => void };

const ROLE_ENV: Partial<Record<CompanyAgentId, string>> = {
  planner: "NAIVE_AGENT_COMPANY_OPERATOR",
  onboarding: "NAIVE_AGENT_COMPANY_OPERATOR",
  market_research: "NAIVE_AGENT_COMMERCIAL",
  prospecting: "NAIVE_AGENT_COMMERCIAL",
  outreach: "NAIVE_AGENT_COMMERCIAL",
};

export const NAIVE_TIMEOUT_MS = 50_000;
const POLL_MS = 1_500;
const MAX_SESSION_BUDGET_MICRO_USD = 250_000;
const TERMINAL = new Set(["idle", "completed", "failed", "cancelled"]);

export interface NaiveOptions {
  env?: Record<string, string | undefined>;
  client?: NaiveCompanyClient;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function defaultClient(apiKey: string, timeoutMs: number): Promise<NaiveCompanyClient> {
  const { createNaiveClient, createNaiveSessionsPort } = await import("@ae/core/agents/naive-adapter");
  return createNaiveSessionsPort(createNaiveClient({ apiKey, timeoutMs: Math.min(timeoutMs, 20_000) }));
}

function errCode(err: unknown): string {
  const e = err as { kind?: string; status?: number | null; name?: string; message?: string } | undefined;
  if (e?.status === 429) return "rate_limited_429";
  if (e?.kind) return `naive_${e.kind}`;
  return (e?.name ?? "error").slice(0, 60);
}

/** Runs one structured call on Naïve; returns null (with a reason) instead of throwing. */
export async function tryNaiveStructured<T>(
  agentId: CompanyAgentId, args: GenerateStructuredArgs<T>, opts: NaiveOptions = {},
): Promise<{ result: StructuredResult<T>; sessionId: string; role: string } | { result: null; reason: string; sessionId?: string; role?: string }> {
  const env = opts.env ?? process.env;
  if (env.COMPANY_AGENT_RUNTIME !== "naive") return { result: null, reason: "runtime_off" };
  const roleEnv = ROLE_ENV[agentId];
  const agentRef = roleEnv ? env[roleEnv] : undefined;
  if (!roleEnv || !agentRef || !env.NAIVE_API_KEY) return { result: null, reason: "missing_env" };
  const role = roleEnv.replace("NAIVE_AGENT_", "");
  const budget = args.ctx.budgetMicroUsd;
  if (budget !== undefined && budget <= 0) return { result: null, reason: "budget_exhausted", role };

  const timeoutMs = Math.min(opts.timeoutMs ?? NAIVE_TIMEOUT_MS, NAIVE_TIMEOUT_MS);
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;
  let sessionId: string | undefined;
  try {
    const client = opts.client ?? await defaultClient(env.NAIVE_API_KEY, timeoutMs);
    const { outputJsonSchema } = await import("@ae/core/agents/session-service");
    const message = [args.system, args.prompt].filter(Boolean).join("\n\n");
    const body: NaiveSessionCreateBody = {
      agent_id: agentRef,
      message,
      budget_micro_usd: Math.min(budget ?? MAX_SESSION_BUDGET_MICRO_USD, MAX_SESSION_BUDGET_MICRO_USD),
      output_schema: outputJsonSchema(args.schema),
      structured_output_required: true,
      metadata: { source: "company", companyAgent: agentId },
    };
    let snap = await client.createSession(body, `company:${agentId}:${globalThis.crypto.randomUUID()}`);
    sessionId = snap.id;
    while (!TERMINAL.has(snap.status)) {
      if (Date.now() >= deadline) return { result: null, reason: "timeout", sessionId, role };
      await sleep(opts.pollMs ?? POLL_MS);
      snap = await client.getSession(snap.id);
    }
    const microUsd = Math.max(0, Math.round(snap.consumedMicroUsd ?? 0));
    await args.ctx.recordCost({
      source: "naive", agent: args.agent, sessionId: snap.id, microUsd,
      meta: { runtime: "naive", role, sessionId: snap.id, status: snap.status, companyAgent: agentId },
    });
    if (snap.status === "failed" || snap.status === "cancelled" || !snap.structuredOutput) {
      return { result: null, reason: `session_${snap.status}`, sessionId, role };
    }
    const check = args.schema.safeParse(snap.structuredOutput);
    if (!check.success) return { result: null, reason: "schema_mismatch", sessionId, role };
    const usage = snap.tokenUsage ?? {};
    return {
      sessionId: snap.id, role,
      result: {
        text: JSON.stringify(check.data), object: check.data, provider: "naive" as unknown as StructuredResult<T>["provider"],
        model: `naive:${role}`, inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0,
        microUsd, costBasis: "gateway_reported", latencyMs: timeoutMs - Math.max(0, deadline - Date.now()),
      },
    };
  } catch (err) {
    return { result: null, reason: errCode(err), sessionId, role };
  }
}

/** Wraps a gateway structured generator so it tries Naïve first (when enabled) and falls back to it on any failure. */
export function withNaive(agentId: CompanyAgentId, fallback: StructuredFn, opts: NaiveOptions = {}): StructuredFn {
  return async <T>(args: GenerateStructuredArgs<T>): Promise<StructuredResult<T>> => {
    const log = (args.ctx as CompanyGatewayContext).logLlmCall;
    const attempt = await tryNaiveStructured(agentId, args, opts);
    if (attempt.result) {
      log?.({ runtime: "naive", role: attempt.role, sessionId: attempt.sessionId });
      return attempt.result;
    }
    log?.({ runtime: "gateway", ...(attempt.role ? { role: attempt.role } : {}), sessionId: attempt.sessionId ?? null, fallbackReason: attempt.reason });
    return fallback(args);
  };
}
