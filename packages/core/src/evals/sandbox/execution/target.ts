import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ToolSpec } from '../../../sandbox/spec';
import { containsSecret } from '../../../agents/redact';
import { canonicalJson } from '../../text/freeze';
import { HttpsJsonTransport, TargetError, targetUrl, type JsonTransport } from '../../../targets/transport';
import type { DispatchEvidence, ObservedUsage } from '../../../targets/remediation';

export interface TargetToolCall { id: string; name: string; args: unknown }
export type TargetMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; content: string; tool_call_id: string };
export interface TargetCompletion { content: string; toolCalls: TargetToolCall[]; usage: ObservedUsage; money: { status: 'unknown' } }
export interface ToolLoopTarget {
  readonly model: string;
  readonly configDigest: string;
  complete(input: { operationId: string; inputDigest: string; messages: readonly TargetMessage[]; signal?: AbortSignal }): Promise<TargetCompletion>;
}
/** Structural compatibility with PostgresRemediationAccounting. Methods must be bound to that instance.
 * Reservations must use shared global/job budget scopes and conservatively bound the entire dispatch.
 */
export interface TargetAccounting {
  authorize(input: { operationId: string; kind: 'target'; inputDigest: string }): Promise<boolean>;
  beforeDispatch(evidence: Readonly<DispatchEvidence>): Promise<void>;
  observed(evidence: Readonly<DispatchEvidence>, usage: Readonly<ObservedUsage>): Promise<void>;
  ambiguous(evidence: Readonly<DispatchEvidence>): Promise<void>;
}
export interface ToolLoopTargetDeps {
  scope: { jobId: string; targetId: string; targetVersion: string; trialId: string; runId: string; scenarioId: string; suiteDigest: string; environment: 'test' };
  endpoint: { url: string; model: string; apiKey?: string };
  config: { temperature: number; seed: number; maxCompletionTokens: number };
  limits: { timeoutMs: number; maxRequestBytes: number; maxResponseBytes: number; maxToolCalls: number };
  tools: readonly ToolSpec[];
  accounting: TargetAccounting;
  currentSecrets(): Promise<readonly string[]>;
  /** Trusted server testing injection only. Default pins public DNS and validates HTTPS/TLS on each call. */
  transport?: JsonTransport;
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const freeze = <T>(v: T): T => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
export const targetDigest = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex');
const fail = (code = 'sandbox_target_refused'): never => { throw new TargetError(code); };
function integer(v: number, min: number, max: number) { if (!Number.isSafeInteger(v) || v < min || v > max) fail(); }
async function bounded<T>(fn: () => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    if (signal?.aborted) fail('sandbox_target_aborted');
    return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TargetError('sandbox_target_unresolved')), ms);
      aborted = () => reject(new TargetError('sandbox_target_aborted'));
      signal?.addEventListener('abort', aborted, { once: true });
    })]);
  } finally { clearTimeout(timer); if (aborted) signal?.removeEventListener('abort', aborted); }
}
function usage(raw: unknown): ObservedUsage {
  const u = (raw as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || !['prompt_tokens', 'completion_tokens', 'total_tokens'].every(k => Number.isSafeInteger(u[k]) && Number(u[k]) >= 0)
    || Number(u.total_tokens) !== Number(u.prompt_tokens) + Number(u.completion_tokens)) return null;
  return { promptTokens: Number(u.prompt_tokens), completionTokens: Number(u.completion_tokens), totalTokens: Number(u.total_tokens) };
}
const Call = z.object({ id: z.string().min(1).max(200), type: z.literal('function'), function: z.object({ name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/), arguments: z.string().max(100_000) }).strict() }).strict();
const Message = z.union([
  z.object({ role: z.enum(['system', 'user']), content: z.string().max(256_000) }).strict(),
  z.object({ role: z.literal('assistant'), content: z.string().max(256_000), tool_calls: z.array(Call).max(60).optional() }).strict(),
  z.object({ role: z.literal('tool'), content: z.string().max(256_000), tool_call_id: z.string().min(1).max(200) }).strict(),
]);
const Response = z.object({ choices: z.array(z.object({ message: z.object({ role: z.literal('assistant'), content: z.string().max(256_000).nullable(), tool_calls: z.array(Call).max(60).optional(), refusal: z.string().nullable().optional() }), finish_reason: z.enum(['stop', 'tool_calls']) })).length(1) });

/** No automatic retries. Unknown or late transport/accounting outcomes remain fenced for reconciliation.
 * Existing accounting evidence's baselineRunId/patchDigest fields are compatibility slots: they contain
 * this trial's runId and pinned configuration digest, NOT a remediation baseline or remote attestation.
 */
export function createToolLoopTarget(deps: ToolLoopTargetDeps): ToolLoopTarget {
  const scope = freeze(copy(deps.scope)), endpoint = freeze(copy(deps.endpoint));
  const config = freeze(copy(deps.config)), limits = freeze(copy(deps.limits));
  targetUrl(endpoint.url);
  if (scope.environment !== 'test' || Object.values(scope).some(v => typeof v !== 'string' || !v.length)
    || !/^[a-f0-9]{64}$/.test(scope.suiteDigest) || !endpoint.model || endpoint.model.length > 200) fail();
  if (endpoint.apiKey !== undefined && (endpoint.apiKey.length < 4 || endpoint.apiKey.length > 8192 || /[^\x21-\x7e]/.test(endpoint.apiKey))) fail();
  integer(limits.timeoutMs, 1, 30_000); integer(limits.maxRequestBytes, 1, 256_000); integer(limits.maxResponseBytes, 1, 1_000_000);
  integer(limits.maxToolCalls, 0, 60); integer(config.maxCompletionTokens, 1, 32_768); integer(config.seed, 0, 2_147_483_647);
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) fail();
  if (!deps.tools.length || deps.tools.length > 60 || new Set(deps.tools.map(t => t.name)).size !== deps.tools.length) fail();
  const tools = freeze(copy(deps.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))));
  const toolNames = new Set(deps.tools.map(t => t.name));
  const accounting = deps.accounting, currentSecrets = deps.currentSecrets;
  const transport = deps.transport ?? new HttpsJsonTransport(limits);
  const configDigest = targetDigest({ endpoint: { url: endpoint.url, model: endpoint.model }, config, tools, limits });
  const attempted = new Set<string>();
  return Object.freeze({ model: endpoint.model, configDigest, async complete(input: Parameters<ToolLoopTarget['complete']>[0]) {
    let evidence: DispatchEvidence | undefined;
    try {
      if (!input.operationId || input.operationId.length > 4096 || !/^[a-f0-9]{64}$/.test(input.inputDigest) || attempted.has(input.operationId)) fail();
      const messages = z.array(Message).min(1).max(1000).parse(copy(input.messages));
      const payload = freeze({ model: endpoint.model, messages, tools, tool_choice: 'auto', parallel_tool_calls: false,
        temperature: config.temperature, seed: config.seed, max_completion_tokens: config.maxCompletionTokens, store: false });
      if (Buffer.byteLength(JSON.stringify(payload)) > limits.maxRequestBytes) fail();
      const readSecrets = async () => {
        const secrets = await bounded(currentSecrets, limits.timeoutMs, input.signal);
        if (!Array.isArray(secrets) || secrets.some(s => typeof s !== 'string' || s.length < 4)) fail();
        return [...secrets, ...(endpoint.apiKey ? [endpoint.apiKey] : [])];
      };
      const secrets = await readSecrets();
      if (containsSecret(JSON.stringify({ payload, scope }), secrets)) fail();
      if (attempted.has(input.operationId)) fail();
      attempted.add(input.operationId);
      // Caller identity and actual immutable serialization are both included in the durable fence digest.
      const inputDigest = targetDigest({ callerDigest: input.inputDigest, scope, configDigest, payload });
      evidence = freeze({ ...scope, baselineRunId: scope.runId, patchDigest: configDigest, operationId: input.operationId,
        inputDigest, payloadDigest: targetDigest(payload) });
      if (!await bounded(() => accounting.authorize({ operationId: input.operationId, kind: 'target', inputDigest }), limits.timeoutMs, input.signal)) fail('sandbox_target_budget_exhausted');
      await bounded(() => accounting.beforeDispatch(evidence!), limits.timeoutMs, input.signal);
      const latest = await readSecrets();
      if (containsSecret(JSON.stringify(payload), latest) || input.signal?.aborted) fail();
      const raw = await bounded(async () => {
        const response = await transport.post(endpoint.url, payload, endpoint.apiKey);
        // Runs even after deadline/abort: late usage enriches reconciliation, never grants permission to retry.
        await accounting.observed(evidence!, usage(response));
        return response;
      }, limits.timeoutMs, input.signal);
      if (Buffer.byteLength(JSON.stringify(raw)) > limits.maxResponseBytes || containsSecret(JSON.stringify(raw), [...secrets, ...latest])) fail();
      const parsed = Response.parse(raw), choice = parsed.choices[0]!;
      if (choice.message.refusal || (choice.finish_reason === 'tool_calls' && !choice.message.tool_calls?.length)
        || (choice.finish_reason === 'stop' && choice.message.tool_calls?.length)) fail();
      const calls = choice.message.tool_calls ?? [];
      if (calls.length > limits.maxToolCalls || new Set(calls.map(c => c.id)).size !== calls.length) fail();
      const toolCalls = calls.map(c => {
        if (!toolNames.has(c.function.name)) fail();
        const args: unknown = JSON.parse(c.function.arguments);
        if (!args || typeof args !== 'object' || Array.isArray(args)) fail();
        // Runtime validates the exact inputSchema before binding SQL. Adapter never executes tool arguments.
        return { id: c.id, name: c.function.name, args };
      });
      if (!toolCalls.length && !choice.message.content?.length) fail();
      return { content: choice.message.content ?? '', toolCalls, usage: usage(raw), money: { status: 'unknown' as const } };
    } catch (error) {
      if (evidence) { try { await bounded(() => accounting.ambiguous(evidence!), limits.timeoutMs); } catch { /* durable reservation/dispatch intent stays held */ } }
      if (error instanceof TargetError && error.code === 'sandbox_target_budget_exhausted') throw error;
      throw new TargetError('sandbox_target_unresolved');
    }
  } });
}
