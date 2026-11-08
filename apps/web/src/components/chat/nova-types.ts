/**
 * Nova chat contract (client-safe). The onboarding agent's replies are AI SDK UIMessages whose generative UI is carried
 * by typed tool parts (`tool-intakeChecklist`, `tool-resultsSummary`, ...). The server is the only author of tool
 * outputs; the client renders them and turns inline actions into validated requests.
 */
import type { UIMessage } from "ai";
import { z } from "zod";
import { GATEWAY_TARGET_MODELS, type ScenarioCategory, type Severity, type SuiteStatus } from "@/components/sandbox/contract";

export type ConversationStatus = "collecting" | "building" | "running" | "reported" | "blocked" | "closed";

/* ---------------- tool outputs ---------------- */

export type ChecklistItemId = "agent" | "tools" | "data" | "policies";
export interface ChecklistItem {
  id: ChecklistItemId;
  label: string;
  state: "done" | "missing" | "optional";
  /** What we have ("openai/gpt-5-mini + system prompt", "OpenAPI spec, 14 KB") or what is needed. */
  detail: string;
  required: boolean;
}
export interface IntakeChecklistOutput { items: ChecklistItem[]; ready: boolean; notes: string[] }

export interface ModelOption { id: string; provider: string; name: string }
export interface ModelPickerOutput { models: ModelOption[]; selected: string | null; hasSystemPrompt: boolean }

export interface EnvironmentCardOutput {
  name: string;
  source: "prebuilt" | "custom";
  tools: Array<{ name: string; effect: "read" | "write" | "external"; description: string }>;
  tables: string[];
  policies: string[];
  workflows: string[];
  warnings: string[];
}

export type GateState = "pass" | "fail" | "pending" | "skipped";
export interface ScenarioPreviewItem {
  id: string;
  title: string;
  category: ScenarioCategory;
  gates: { oracle: GateState; null: GateState; mutation: GateState };
  validated: boolean | null;
  reasons: string[];
}
export interface ScenarioPreviewOutput {
  status: SuiteStatus;
  error?: string;
  scenarios: ScenarioPreviewItem[];
  total: number;
  validated: number;
  costUsd: number;
}

export interface CostEstimateOutput {
  scenarios: number;
  k: number;
  trials: number;
  estimateUsd: number;
  /** Plan headroom this month (null = no monthly cap). */
  headroomUsd: number | null;
  runCapUsd: number;
  planName: string;
  /** Even a minimal run is over budget: confirming asks a founder to approve. */
  blocked: boolean;
}

export type TrialCell = "pass" | "fail" | "running" | "pending";
export interface RunProgressOutput {
  runId: string;
  status: "queued" | "running" | "complete" | "failed";
  k: number;
  trialsDone: number;
  trialsTotal: number;
  costUsd: number;
  budgetUsd: number;
  rows: Array<{ scenarioId: string; title: string; category: ScenarioCategory; cells: TrialCell[] }>;
  error?: string;
  runUrl: string;
}

export interface EvidenceItem {
  id: string;
  scenarioTitle: string;
  trial: number;
  /** The failed check, in the grader's words. */
  check: string;
  excerpt: string;
  role: "user" | "assistant" | "tool";
}
export interface ResultsSummaryOutput {
  runId: string;
  k: number;
  scenarios: number;
  trials: number;
  passAt1: number;
  passHatK: number;
  ci95: [number, number];
  costUsd: number;
  byCategory: Array<{ category: ScenarioCategory; passed: number; total: number }>;
  clusters: Array<{ id: string; title: string; rootCause: string; severity: Severity; attribution: string; trialCount: number; evidence: string[] }>;
  evidence: EvidenceItem[];
  runUrl: string;
}

export type NovaTools = {
  intakeChecklist: { input: Record<string, never>; output: IntakeChecklistOutput };
  modelPicker: { input: Record<string, never>; output: ModelPickerOutput };
  environmentCard: { input: { suiteId: string }; output: EnvironmentCardOutput };
  scenarioPreview: { input: { suiteId: string }; output: ScenarioPreviewOutput };
  costEstimate: { input: Record<string, never>; output: CostEstimateOutput };
  runProgress: { input: { runId: string }; output: RunProgressOutput };
  resultsSummary: { input: { runId: string }; output: ResultsSummaryOutput };
};
export type NovaToolName = keyof NovaTools;
export const NOVA_TOOL_NAMES = ["intakeChecklist", "modelPicker", "environmentCard", "scenarioPreview", "costEstimate", "runProgress", "resultsSummary"] as const satisfies readonly NovaToolName[];

export interface NovaMetadata { conversationId?: string; status?: ConversationStatus; at?: string }
export type NovaData = { thinking: { label: string } };
export type NovaUIMessage = UIMessage<NovaMetadata, NovaData, NovaTools>;
export type NovaPart = NovaUIMessage["parts"][number];

/** A tool output persisted on a transcript entry so history re-renders the same components. */
export interface StoredUiPart<N extends NovaToolName = NovaToolName> { tool: N; id: string; input: NovaTools[N]["input"]; output: NovaTools[N]["output"] }

/* ---------------- requests ---------------- */

export const ATTACHMENT_KINDS = ["openapi", "tools", "schema", "policies"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
/** Per-kind byte caps (mirror OnboardingRequirements limits). */
export const ATTACHMENT_MAX_BYTES: Record<AttachmentKind, number> = { openapi: 500_000, tools: 200_000, schema: 200_000, policies: 20_000 };
export const ATTACHMENT_ACCEPT = ".json,.yaml,.yml,.sql,.md,.txt";
export const MAX_ATTACHMENTS = 4;
export const ATTACHMENT_LABEL: Record<AttachmentKind, string> = { openapi: "OpenAPI spec", tools: "MCP tool list", schema: "Database schema", policies: "Policies" };

export const ChatAttachment = z.object({
  kind: z.enum(ATTACHMENT_KINDS),
  name: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(ATTACHMENT_MAX_BYTES.openapi),
});
export type ChatAttachment = z.infer<typeof ChatAttachment>;

export const ChatFields = z.object({
  endpointUrl: z.url().max(2_000).optional(),
  model: z.enum(GATEWAY_TARGET_MODELS).optional(),
  systemPrompt: z.string().trim().min(1).max(50_000).optional(),
  prebuiltWorld: z.literal("acme-support").optional(),
}).strict();
export type ChatFields = z.infer<typeof ChatFields>;

export const CHAT_ACTIONS = ["confirm", "cancel"] as const;
export type ChatAction = (typeof CHAT_ACTIONS)[number];

/** Guesses an attachment's kind from its name and content; null when it is none of the four. */
export function classifyAttachment(name: string, content: string): AttachmentKind | null {
  const head = content.slice(0, 4_000);
  if (/^\s*(openapi|swagger)\s*:/m.test(head) || /"(openapi|swagger)"\s*:/.test(head)) return "openapi";
  if (/\bcreate\s+table\b/i.test(content)) return "schema";
  if (/\.sql$/i.test(name)) return null;
  const trimmed = content.trim();
  if (/\.json$/i.test(name) || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const j: unknown = JSON.parse(trimmed);
      const list = Array.isArray(j) ? j : (j as { tools?: unknown } | null)?.tools;
      return Array.isArray(list) && list.length > 0 ? "tools" : null;
    } catch { return null; }
  }
  if (/\.(md|txt)$/i.test(name)) return "policies";
  return null;
}

/** Client- and server-side check for one attachment. Returns a customer-facing reason, or null when acceptable. */
export function attachmentProblem(a: { kind: AttachmentKind; name: string; content: string }): string | null {
  const bytes = new TextEncoder().encode(a.content).length;
  if (bytes === 0) return `${a.name} is empty.`;
  if (bytes > ATTACHMENT_MAX_BYTES[a.kind]) return `${a.name} is ${Math.ceil(bytes / 1000)} KB; ${ATTACHMENT_LABEL[a.kind]} files can be at most ${ATTACHMENT_MAX_BYTES[a.kind] / 1000} KB.`;
  const detected = classifyAttachment(a.name, a.content);
  if (a.kind !== "policies" && detected !== a.kind) return `${a.name} doesn't look like ${ATTACHMENT_LABEL[a.kind].toLowerCase()}.`;
  return null;
}

export const modelOptions = (): ModelOption[] => GATEWAY_TARGET_MODELS.map((id) => {
  const [provider = "", name = id] = id.split("/");
  return { id, provider, name };
});
