/**
 * Shim for Anthropic's claude-quickstarts `customer-support-agent` (anthropics/claude-quickstarts, MIT).
 * Upstream: customer-support-agent/ @ 4a4224bdf0e9cfb3332167b69c90457403813625.
 *
 * What runs is the REAL Next.js route handler: `POST` from app/api/chat/route.ts (its system prompt, category list,
 * "{" assistant prefill, JSON parsing, zod schema and its own error reply), with app/lib/utils.ts's retrieveContext.
 * The shim builds the same Request the app's chat UI sends ({messages, model, knowledgeBaseId}) and returns the
 * `response` field, which is what the chat window shows the customer.
 *
 * Swapped / not used:
 *   - Model: ANTHROPIC_BASE_URL = AI Gateway (Anthropic-compatible API), ANTHROPIC_API_KEY = our gateway key, read
 *     by the route's own `new Anthropic(...)`. The row's gateway model id is sent as `model`.
 *   - RAG: no knowledgeBaseId is sent, so retrieveContext takes its own "knowledgeBaseId is not provided" branch and
 *     never calls AWS Bedrock (a third-party service we do not call). The prompt then says "No information found".
 *   - Provider safety blocks: fetch is observed (not altered); if the gateway reports a refusal / content filter for
 *     the request, the reply is the shared PROVIDER_REFUSAL, as in oss_bb_common.py.
 *
 * Start (repo root): CS_AGENT_DIR=<checkout>/customer-support-agent \
 *   npx tsx --tsconfig $CS_AGENT_DIR/tsconfig.json scripts/demo/shims/claude_cs_agent_shim.mts --port 8773 --env-file .env
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PROVIDER_REFUSAL = "Sorry, I can't help with that request.";
const GATEWAY_ANTHROPIC = "https://ai-gateway.vercel.sh";
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const port = Number(arg("--port") ?? 8773);
const envFile = arg("--env-file");
if (envFile && !process.env.AI_GATEWAY_API_KEY) {
  const line = readFileSync(envFile, "utf8").split("\n").find((l) => l.startsWith("AI_GATEWAY_API_KEY="));
  if (line) process.env.AI_GATEWAY_API_KEY = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
}
if (!process.env.AI_GATEWAY_API_KEY) { console.error("AI_GATEWAY_API_KEY missing"); process.exit(1); }
process.env.ANTHROPIC_API_KEY = process.env.AI_GATEWAY_API_KEY;
process.env.ANTHROPIC_BASE_URL = GATEWAY_ANTHROPIC;
const dir = process.env.CS_AGENT_DIR;
if (!dir) { console.error("CS_AGENT_DIR missing"); process.exit(1); }

// Observe (never modify) gateway responses so a provider refusal is recognised, per request.
const seen = new AsyncLocalStorage<{ refused: boolean }>();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const res = await realFetch(input, init);
  const store = seen.getStore();
  if (store && String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).startsWith(GATEWAY_ANTHROPIC)) {
    try {
      const t = (await res.clone().text()).toLowerCase();
      if (/"stop_reason":"refusal"|content[-_ ]filter|safeguards flagged|flagged for possible/.test(t)) store.refused = true;
    } catch { /* body not readable: nothing to observe */ }
  }
  return res;
};

const { POST } = (await import(pathToFileURL(join(dir, "app/api/chat/route.ts")).href)) as { POST: (req: Request) => Promise<Response> };

interface Msg { role: string; content: string }
const textOf = (c: unknown): string => Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("") : String(c ?? "");
const stats = { requests: 0, turns: 0, provider_refusals: 0, app_errors: 0 };

async function turn(model: string, messages: Msg[]): Promise<{ reply: string; status: number; refused: boolean }> {
  const store = { refused: false };
  return seen.run(store, async () => {
    const req = new Request("http://127.0.0.1/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages, model }) });
    const res = await POST(req);
    const body = (await res.json()) as { response?: string };
    return { reply: String(body.response ?? ""), status: res.status, refused: store.refused };
  });
}

createServer(async (req, res) => {
  const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "GET" && req.url === "/stats") return send(200, stats);
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, agent: "claude-quickstarts-customer-support-agent", commit: "4a4224b" });
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") return send(404, { error: { message: "not found" } });
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  stats.requests += 1;
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string; messages?: Array<{ role: string; content: unknown }> };
    const model = body.model ?? "openai/gpt-5.5";
    // Client system messages are ignored, as in every shim (the app has its own system prompt).
    const messages = (body.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: textOf(m.content) }));
    if (!messages.length || messages[messages.length - 1]!.role !== "user") return send(400, { error: { message: "last message must be from the user" } });
    const out = await turn(model, messages);
    let reply = out.reply;
    if (out.refused) { stats.provider_refusals += 1; reply = PROVIDER_REFUSAL; console.log(`[claude-cs] ${model}: provider safety block -> refusal reply`); }
    else if (out.status !== 200) { stats.app_errors += 1; console.log(`[claude-cs] ${model}: app returned ${out.status} (its own error reply is the answer)`); }
    stats.turns += 1;
    return send(200, {
      id: "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24), object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      x_conversation: createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 12),
    });
  } catch (e) {
    console.error("[claude-cs] shim error", e instanceof Error ? e.message : e);
    return send(502, { error: { message: "shim error", type: "server_error" } });
  }
}).listen(port, "127.0.0.1", () => console.log(`claude-cs shim on 127.0.0.1:${port}`));
