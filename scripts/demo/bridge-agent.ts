/**
 * "Real agent" driver for the sandbox engine: the agent is a third-party open-source app running from its own code
 * (its prompts, agent graph and tool functions) behind a small local shim. The shim patches ONLY the agent's tool
 * functions so they call back into our sandbox (this bridge), which executes them with SandboxRun.callTool against the
 * trial's Neon branch. So the state we grade is exactly what the real agent's tools did.
 *
 * Shim contract (see scratchpad shims / data/envs/<env>/NOTICE.md):
 *   POST {shim}/session/start   {session_id, model, bridge_url}  -> {ok: true}
 *   POST {shim}/session/message {session_id, message}            -> {reply, usage?: {prompt_tokens, completion_tokens, cost_usd?}, error?}
 *   POST {shim}/session/end     {session_id}                     -> {ok: true}
 *   tool call from the shim:  POST {bridge_url} {tool, args}     -> {result} | {error}
 * The bridge listens on 127.0.0.1 only and accepts calls only for live sessions.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SandboxRun } from "../../packages/core/src/sandbox/spec";
import type { AgentFactory, AgentTurn, TranscriptEntry } from "../../packages/core/src/sandbox/engine/index";

const MAX_BODY = 256_000;
const SHIM_TIMEOUT_MS = 240_000;
const TRANSCRIPT_TOOL_CHARS = 2_000;

export interface BridgeUsage { prompt_tokens?: number; completion_tokens?: number; cost_usd?: number }
export interface Bridge { url: string; close(): Promise<void> }

const sessions = new Map<string, { run: SandboxRun; transcript: TranscriptEntry[] }>();

/** Starts the local tool bridge. Route: POST /bridge/<sessionId>. */
export async function startBridge(): Promise<Bridge> {
  const server: Server = createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const m = /^\/bridge\/([A-Za-z0-9_-]{1,80})$/.exec(req.url ?? "");
    const sess = m ? sessions.get(m[1]!) : undefined;
    if (req.method !== "POST" || !sess) return send(404, { error: "unknown session" });
    let raw = "";
    req.on("data", (c: Buffer) => { raw += c.toString("utf8"); if (raw.length > MAX_BODY) req.destroy(); });
    req.on("end", () => {
      let body: { tool?: unknown; args?: unknown };
      try { body = JSON.parse(raw) as typeof body; } catch { return send(400, { error: "invalid json" }); }
      if (typeof body.tool !== "string") return send(400, { error: "tool required" });
      const args = body.args && typeof body.args === "object" ? body.args : {};
      sess.run.callTool(body.tool, args).then((rec) => {
        const out = rec.error ? { error: rec.error } : { result: rec.result };
        const text = JSON.stringify(out);
        sess.transcript.push({ role: "tool", content: `${body.tool}(${JSON.stringify(args)}) -> ${text}`.slice(0, TRANSCRIPT_TOOL_CHARS) });
        send(200, out);
      }).catch((e: unknown) => send(500, { error: e instanceof Error ? e.message : String(e) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(SHIM_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`shim HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

export interface BridgeAgentOptions {
  name: string;
  shimUrl: string;
  bridge: Bridge;
  model: string;
  /** Called with every turn's usage so the caller can meter agent spend. */
  onUsage?: (u: BridgeUsage) => void;
}

/** AgentFactory over a real-agent shim. One shim session per trial; tools route back to that trial's SandboxRun. */
export function bridgeAgent(opts: BridgeAgentOptions): AgentFactory {
  return {
    name: opts.name,
    start({ run }) {
      const sessionId = `s_${run.runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}_${Math.random().toString(36).slice(2, 8)}`;
      const state = { run, transcript: [] as TranscriptEntry[] };
      sessions.set(sessionId, state);
      let started: Promise<unknown> | undefined;
      return {
        async send(message: string): Promise<AgentTurn> {
          state.transcript = [];
          try {
            started ??= post(`${opts.shimUrl}/session/start`, { session_id: sessionId, model: opts.model, bridge_url: `${opts.bridge.url}/bridge/${sessionId}` });
            await started;
            const out = await post(`${opts.shimUrl}/session/message`, { session_id: sessionId, message });
            if (out.usage && typeof out.usage === "object") opts.onUsage?.(out.usage as BridgeUsage);
            const reply = typeof out.reply === "string" ? out.reply : "";
            const transcript = [...state.transcript, { role: "assistant" as const, content: reply }];
            return typeof out.error === "string" && out.error
              ? { reply, transcript, costMicroUsd: 0, error: `agent_error: ${out.error.slice(0, 200)}` }
              : { reply, transcript, costMicroUsd: 0 };
          } catch (e) {
            return { reply: "", transcript: state.transcript, costMicroUsd: 0, error: `agent_error: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
          }
        },
      };
    },
  };
}

/** Drop a finished session (call after the trial). */
export function endBridgeSession(shimUrl: string, runId: string): void {
  for (const id of sessions.keys()) {
    if (!id.includes(runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60))) continue;
    sessions.delete(id);
    void post(`${shimUrl}/session/end`, { session_id: id }).catch(() => undefined);
  }
}
