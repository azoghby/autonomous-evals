import type { ConnectMode, DataFormat, SandboxIntakeRequest, ToolsFormat } from "../contract";

export interface PolicyRow { title: string; text: string }

/** Flat string-based form state; converted to a SandboxIntakeRequest by buildRequest. */
export interface WizardForm {
  mode: ConnectMode;
  name: string;
  domain: string;
  // tool_loop
  endpointUrl: string; model: string; systemPrompt: string;
  // sandbox_api / staging
  chatEndpointUrl: string;
  // repo
  repoUrl: string; ref: string; installCommand: string; startCommand: string; chatPath: string; port: string;
  // voice
  wsUrl: string; protocol: "openai_realtime" | "gemini_live" | "pipecat" | "livekit" | "custom_pcm"; sampleRateHz: string;
  // world
  toolsFormat: ToolsFormat; toolsContent: string;
  dataFormat: DataFormat; dataContent: string;
  policies: PolicyRow[];
  workflowNotes: string;
}

export const MAX_POLICIES = 20;

export const initialForm = (): WizardForm => ({
  mode: "tool_loop", name: "", domain: "",
  endpointUrl: "", model: "", systemPrompt: "",
  chatEndpointUrl: "",
  repoUrl: "", ref: "main", installCommand: "npm install", startCommand: "npm start", chatPath: "/v1/chat/completions", port: "3000",
  wsUrl: "", protocol: "openai_realtime", sampleRateHz: "16000",
  toolsFormat: "function_json", toolsContent: "", dataFormat: "infer", dataContent: "", policies: [], workflowNotes: "",
});

const num = (s: string): number => (s.trim() === "" ? Number.NaN : Number(s));
const opt = (s: string) => (s.trim() === "" ? undefined : s);

function integration(f: WizardForm): SandboxIntakeRequest["integration"] {
  switch (f.mode) {
    case "tool_loop":
      return { mode: "tool_loop", endpointUrl: f.endpointUrl.trim(), model: f.model.trim(), systemPrompt: opt(f.systemPrompt) };
    case "sandbox_api":
      return { mode: "sandbox_api", chatEndpointUrl: f.chatEndpointUrl.trim() };
    case "staging":
      return { mode: "staging", chatEndpointUrl: f.chatEndpointUrl.trim() };
    case "repo":
      return { mode: "repo", repoUrl: f.repoUrl.trim(), ref: f.ref.trim(), installCommand: f.installCommand, startCommand: f.startCommand, chatPath: f.chatPath.trim(), port: num(f.port) };
    case "realtime_voice":
      return { mode: "realtime_voice", wsUrl: f.wsUrl.trim(), protocol: f.protocol, sampleRateHz: num(f.sampleRateHz) };
  }
}

export function buildRequest(f: WizardForm): SandboxIntakeRequest {
  return {
    name: f.name,
    domain: f.domain,
    integration: integration(f),
    world: {
      tools: { format: f.toolsFormat, content: f.toolsContent },
      data: { format: f.dataFormat, content: f.dataFormat === "infer" ? "" : f.dataContent },
      policies: f.policies.filter((p) => p.title.trim() || p.text.trim()),
      workflowNotes: f.workflowNotes,
    },
  };
}

/** Which form field (error key) each zod path prefix belongs to. Keys are path.join("."). */
export const CONNECT_ERROR_PREFIXES = ["name", "domain", "integration"];
export const WORLD_ERROR_PREFIXES = ["world"];
export const stepOfError = (key: string): 0 | 1 => (key.startsWith("world") ? 1 : 0);

const EXAMPLE_TOOLS = JSON.stringify(
  [
    { name: "lookup_order", description: "Look up an order by id or customer email.", parameters: { type: "object", properties: { order_id: { type: "string" }, email: { type: "string" } } } },
    { name: "issue_refund", description: "Refund an order, fully or partly.", parameters: { type: "object", properties: { order_id: { type: "string" }, amount_cents: { type: "integer" }, reason: { type: "string" } }, required: ["order_id", "amount_cents"] } },
  ],
  null,
  2,
);

export const withExample = (f: WizardForm): WizardForm => ({
  ...f,
  name: f.name || "Support agent",
  domain: f.domain || "E-commerce support",
  toolsFormat: "function_json",
  toolsContent: EXAMPLE_TOOLS,
  dataFormat: "infer",
  policies: [{ title: "Refund policy", text: "Orders can be refunded within 30 days of delivery. Refunds over $200 require human approval. Always verify the customer's email before changing an order." }],
});
