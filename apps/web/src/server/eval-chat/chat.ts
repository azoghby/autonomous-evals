/**
 * Eval copilot turn: load the owner's thread from the DB (the client sends only its new message), stream a grounded reply
 * with typed tool parts, persist the user + assistant messages, and record model spend in `costs`.
 */
import { randomUUID } from "node:crypto";
import {
  convertToModelMessages, createGateway, createUIMessageStreamResponse, stepCountIs, streamText, toUIMessageStream, type LanguageModel,
} from "ai";
import { z } from "zod";
import { MODELS } from "@ae/core/ai/models";
import type { EvalUIMessage } from "@/lib/eval-chat/types";
import type { ActionDeps, EvalContext } from "./actions";
import { systemPrompt } from "./prompt";
import { buildEvalTools } from "./tools";

export const MAX_MESSAGE_CHARS = 4_000;
const HISTORY_FOR_MODEL = 30;
const MAX_STEPS = 6;
const MAX_OUTPUT_TOKENS = 1_500;

/** Only a user text message is accepted from the client; ids, roles and tool parts are server-owned. */
export const IncomingMessage = z.object({
  role: z.literal("user"),
  parts: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1).max(4),
});

export function toUserMessage(raw: unknown): { ok: true; message: EvalUIMessage } | { ok: false; error: string } {
  const parsed = IncomingMessage.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Send a text message." };
  const text = parsed.data.parts.map((p) => p.text).join("\n").trim();
  if (!text) return { ok: false, error: "Send a text message." };
  if (text.length > MAX_MESSAGE_CHARS) return { ok: false, error: `Keep messages under ${MAX_MESSAGE_CHARS} characters.` };
  return { ok: true, message: { id: `msg_${randomUUID()}`, role: "user", parts: [{ type: "text", text }], metadata: { createdAt: new Date().toISOString() } } };
}

const textOf = (m: EvalUIMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n").trim();

export interface ChatDeps extends ActionDeps {
  model?: LanguageModel;
  /** Copilot model spend by this owner in the last 24h (micro-USD); enables the daily cap. */
  spentTodayMicroUsd?: (ownerId: string) => Promise<number>;
  recordCost?: (entry: { ownerId: string; ctx: EvalContext; microUsd: number; inputTokens: number; outputTokens: number; basis: string }) => Promise<void>;
}

export function copilotModel(): LanguageModel {
  const key = process.env.AI_GATEWAY_API_KEY;
  return (key ? createGateway({ apiKey: key }) : createGateway())(MODELS.sonnet.vercel);
}

type Step = { providerMetadata?: unknown; usage?: { inputTokens?: number; outputTokens?: number } };

/** Gateway-reported cost when present, else list price. */
export function turnCost(steps: readonly Step[], usage: { inputTokens?: number; outputTokens?: number }) {
  let reported = 0, sawReported = false;
  for (const s of steps) {
    const gw = (s.providerMetadata as { gateway?: { cost?: string | number } } | undefined)?.gateway;
    const n = typeof gw?.cost === "string" ? Number.parseFloat(gw.cost) : gw?.cost;
    if (typeof n === "number" && Number.isFinite(n)) { reported += n; sawReported = true; }
  }
  const inputTokens = usage.inputTokens ?? 0, outputTokens = usage.outputTokens ?? 0;
  const p = MODELS.sonnet.priceUsdPerMTok;
  const usd = sawReported ? reported : (inputTokens * p.input + outputTokens * p.output) / 1e6;
  return { microUsd: Math.max(0, Math.round(usd * 1e6)), inputTokens, outputTokens, basis: sawReported ? "gateway_reported" : "list_price_estimate" };
}

export class CopilotBudgetError extends Error {
  constructor() { super("You have used today's copilot allowance. It resets within 24 hours."); this.name = "CopilotBudgetError"; }
}

export const COPILOT_DAILY_BUDGET_USD = () => Number(process.env.EVAL_COPILOT_DAILY_BUDGET_USD ?? 2) || 2;

export async function streamCopilotTurn(deps: ChatDeps, ctx: EvalContext, message: EvalUIMessage, abortSignal?: AbortSignal): Promise<Response> {
  if (deps.spentTodayMicroUsd && (await deps.spentTodayMicroUsd(ctx.ownerId)) >= COPILOT_DAILY_BUDGET_USD() * 1e6) throw new CopilotBudgetError();
  const loaded = await deps.store.loadMessages(ctx.ownerId, ctx.ref);
  // Retry after a failed turn resends the same question: answer it again instead of storing a duplicate.
  const last = loaded[loaded.length - 1];
  const isRetry = last?.role === "user" && textOf(last) === textOf(message);
  const history = isRetry ? loaded.slice(0, -1) : loaded;
  const userMessage = isRetry ? last : message;
  if (!isRetry) await deps.store.saveMessages(ctx.ownerId, ctx.ref, [message]);
  const tools = buildEvalTools(ctx, deps);
  const thread = [...history, userMessage];
  const modelMessages = await convertToModelMessages(thread.slice(-HISTORY_FOR_MODEL), { tools, ignoreIncompleteToolCalls: true });

  const result = streamText({
    model: deps.model ?? copilotModel(),
    instructions: systemPrompt(ctx),
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal,
    // Per step, so a client disconnect mid-turn cannot skip recording what was already spent.
    onStepEnd: async (step) => {
      const cost = turnCost([step], step.usage);
      if (cost.microUsd > 0) await deps.recordCost?.({ ownerId: ctx.ownerId, ctx, ...cost }).catch((err) => console.error("eval copilot cost record failed", err instanceof Error ? err.message : err));
    },
  });

  const stream = toUIMessageStream<typeof tools, EvalUIMessage>({
    stream: result.stream,
    tools,
    originalMessages: thread,
    generateMessageId: () => `msg_${randomUUID()}`,
    messageMetadata: ({ part }) => (part.type === "start" ? { createdAt: new Date().toISOString() } : undefined),
    onError: (err) => {
      console.error("eval copilot stream failed", err instanceof Error ? err.message : err);
      return "The copilot could not answer just now. Try again.";
    },
    onEnd: async ({ responseMessage }) => {
      if (responseMessage.parts.length) await deps.store.saveMessages(ctx.ownerId, ctx.ref, [responseMessage]);
    },
  });
  return createUIMessageStreamResponse({ stream });
}
