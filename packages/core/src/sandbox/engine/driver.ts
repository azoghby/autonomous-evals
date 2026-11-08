/**
 * `tool_loop` customer agent driver (integration mode B): an OpenAI-compatible endpoint returns tool_calls,
 * WE execute them against the sandbox run. The driver knows nothing about the scenario.
 * The API key never appears in returned strings and is never logged.
 */
import { isIP } from "node:net";
import type { EnvironmentSpec, SandboxRun, ToolSpec } from "../spec";
import {
  ChatCompletionsClient,
  type AssistantMessage,
  type ChatMessage,
  type FunctionTool,
} from "../../targets/chat";
import { HttpsJsonTransport, TargetError, TargetGate, resolvePublic, targetUrl, type JsonTransport } from "../../targets/transport";
import type { AgentFactory, AgentSession, AgentStartInput, AgentTurn, TranscriptEntry } from "./types";
import { clip, safeJson, scrubber } from "./util";

export interface ToolLoopTarget {
  endpointUrl: string;
  model: string;
  apiKey?: string;
  systemPrompt?: string;
  maxCompletionTokens?: number;
}

export interface ToolLoopOptions {
  transport?: JsonTransport;
  maxStepsPerTurn?: number;
  maxToolCallsPerTurn?: number;
  maxToolResultChars?: number;
}

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_RESULT_CHARS = 8_000;
const TRANSCRIPT_TOOL_CHARS = 2_000;
const BUSY_RETRIES = 5;
const BUSY_BACKOFF_MS = 150;

export function toolsForOpenAI(tools: ToolSpec[]): FunctionTool[] {
  return tools.map((t) => {
    const { $schema: _ignored, ...rest } = t.inputSchema as Record<string, unknown>;
    const props = rest.properties;
    const properties = props && typeof props === "object" && !Array.isArray(props) ? props : {};
    return {
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: { ...rest, type: "object", properties } },
    };
  });
}

export function targetFromEnv(env: EnvironmentSpec, apiKey?: string): ToolLoopTarget {
  const integration = env.integration;
  if (integration.mode !== "tool_loop") throw new Error(`unsupported integration mode: ${integration.mode}`);
  return {
    endpointUrl: integration.endpointUrl,
    model: integration.model,
    ...(apiKey ? { apiKey } : {}),
    ...(integration.systemPrompt ? { systemPrompt: integration.systemPrompt } : {}),
  };
}

/** URL checks needing no network: HTTPS-only, no localhost, IP literals must be public (mirrors lite/run.ts). */
async function validateEndpoint(url: string): Promise<void> {
  const parsed = targetUrl(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) await resolvePublic(host);
}

const errCode = (e: unknown): string => (e instanceof TargetError ? e.code : "target_error");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function completeWithRetry(client: ChatCompletionsClient, messages: ChatMessage[], tools: FunctionTool[]): Promise<AssistantMessage> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.complete([...messages], tools);
    } catch (e) {
      if (!(e instanceof TargetError && e.code === "target_busy") || attempt >= BUSY_RETRIES) throw e;
      await sleep(BUSY_BACKOFF_MS * (attempt + 1));
    }
  }
}

function parseArgs(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false } {
  if (raw.trim() === "") return { ok: true, args: {} };
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, args: v as Record<string, unknown> };
  } catch { /* fall through */ }
  return { ok: false };
}

export function toolLoopAgent(target: ToolLoopTarget, opts: ToolLoopOptions = {}): AgentFactory {
  const transport = opts.transport ?? new HttpsJsonTransport({ gate: new TargetGate() });
  const maxSteps = opts.maxStepsPerTurn ?? DEFAULT_MAX_STEPS;
  const maxToolCalls = opts.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS;
  const maxResultChars = opts.maxToolResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const scrub = scrubber(target.apiKey);

  return {
    name: `tool_loop:${target.model}`,
    start({ env, run }: AgentStartInput): AgentSession {
      const history: ChatMessage[] = target.systemPrompt ? [{ role: "system", content: target.systemPrompt }] : [];
      const tools = toolsForOpenAI(env.tools);
      let client: ChatCompletionsClient | undefined;
      let validated = false;

      const execTool = async (run: SandboxRun, name: string, rawArgs: string): Promise<{ content: string; entry: TranscriptEntry }> => {
        const parsed = parseArgs(rawArgs);
        let resultJson: string;
        if (!parsed.ok) {
          resultJson = JSON.stringify({ error: "invalid_arguments_json" });
        } else {
          const rec = await run.callTool(name, parsed.args);
          resultJson = safeJson(rec.error ? { error: rec.error } : rec.result, maxResultChars);
        }
        const entry: TranscriptEntry = { role: "tool", content: scrub(clip(`${name}(${rawArgs}) -> ${resultJson}`, TRANSCRIPT_TOOL_CHARS)) };
        return { content: resultJson, entry };
      };

      return {
        async send(userMessage: string): Promise<AgentTurn> {
          const transcript: TranscriptEntry[] = [];
          const fail = (error: string, reply = ""): AgentTurn => ({ reply: scrub(reply), transcript, costMicroUsd: 0, error: scrub(error) });
          history.push({ role: "user", content: userMessage });
          try {
            if (!validated) {
              await validateEndpoint(target.endpointUrl);
              validated = true;
            }
            client ??= new ChatCompletionsClient(
              { endpoint: target.endpointUrl, model: target.model, bearer: target.apiKey, maxCompletionTokens: target.maxCompletionTokens },
              transport,
            );
            let lastContent = "";
            let toolCalls = 0;
            for (let step = 0; step < maxSteps; step++) {
              const msg = await completeWithRetry(client, history, tools);
              history.push(msg);
              lastContent = msg.content ?? lastContent;
              const calls = msg.tool_calls ?? [];
              if (calls.length === 0) {
                const reply = scrub(msg.content ?? "");
                transcript.push({ role: "assistant", content: reply });
                return { reply, transcript, costMicroUsd: 0 };
              }
              for (const tc of calls) {
                if (++toolCalls > maxToolCalls) return fail("tool_loop_limit", lastContent);
                const { content, entry } = await execTool(run, tc.function.name, tc.function.arguments);
                transcript.push(entry);
                history.push({ role: "tool", tool_call_id: tc.id, content });
              }
            }
            return fail("tool_loop_limit", lastContent);
          } catch (e) {
            return fail(errCode(e));
          }
        },
      };
    },
  };
}
