import { createUIMessageStreamResponse } from "ai";
import { PLANS } from "@ae/core/pricing/plans";
import { getCustomerPlan } from "@ae/core/payments/plans-checkout";
import { attachmentProblem } from "@/components/chat/nova-types";
import { ChatTurnBody, customerLine, toAgentAttachments } from "@/server/company/onboarding-chat-request";
import { jsonError, readJson, requireViewer } from "@/server/http";
import { clientIp, rateLimit } from "@/server/rate-limit";
import { getSandboxService } from "@/server/sandbox-service";
import {
  advanceOnboardingConversation, estimateOnboardingRun, handleOnboardingMessage, skipReason,
} from "@/server/company/onboarding";
import { drizzleOnboardingStore, type ConversationRow } from "@/server/company/onboarding-store";
import {
  costEstimateView, hydrateMessages, impliedLiveParts, turnUiParts, withLastAgentUi, type ChatTranscriptEntry, type LiveSources,
} from "@/server/company/onboarding-chat";
import { novaTurnStream } from "@/server/company/onboarding-chat-stream";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const tooMany = (retryAfter: number) =>
  Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });

const sources = (customerId: string): LiveSources => {
  const svc = getSandboxService();
  return { getDraft: (id) => svc.getDraft(customerId, id), getRunReport: (id) => svc.getRunReport(customerId, id) };
};

class TurnError extends Error {}

export async function POST(req: Request) {
  const ipLimit = await rateLimit(`sandbox-assistant-ip:${clientIp(req)}`, 60, 3600);
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfter);
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const userLimit = await rateLimit(`sandbox-assistant:${auth.viewer.id}`, 40, 3600);
  if (!userLimit.ok) return tooMany(userLimit.retryAfter);
  const body = await readJson(req, ChatTurnBody);
  if (!body.ok) return body.res;
  const problem = body.data.attachments.map(attachmentProblem).find(Boolean);
  if (problem) return jsonError(422, problem);
  const customerId = auth.viewer.id;
  const b = body.data;
  const store = drizzleOnboardingStore();

  const stream = novaTurnStream({
    thinking: b.action === "confirm" ? "Building your sandbox" : b.attachments.length ? "Reading your files" : "Reading your message",
    src: () => sources(customerId),
    onError: (err) => {
      if (err instanceof TurnError) return err.message;
      console.error("sandbox assistant failed", err instanceof Error ? err.message : err);
      return "Could not process that message.";
    },
    run: async () => {
      const out = await handleOnboardingMessage({
        customerId, channel: "chat", text: customerLine(b), conversationId: b.conversationId, requireConfirm: true,
        ...(b.attachments.length ? { attachments: toAgentAttachments(b.attachments) } : {}),
        ...(b.fields ? { fields: b.fields } : {}),
        ...(b.action ? { action: b.action } : {}),
      });
      const skipped = skipReason(out.result);
      if (skipped === "disabled") throw new TurnError("The onboarding assistant is off right now.");
      if (skipped === "daily_budget_exhausted") throw new TurnError("The onboarding assistant is resting for today. Please try again tomorrow.");
      if (!out.conversationId) throw new TurnError(out.reply || "Could not process that message.");
      const conv = await store.getConversation(out.conversationId);
      if (!conv) return { reply: out.reply, conversationId: out.conversationId, status: out.status, ui: [] };
      const cost = out.awaitingConfirm
        ? costEstimateView(await estimateOnboardingRun(customerId), PLANS[await getCustomerPlan(customerId)].name)
        : undefined;
      const at = conv.transcript.at(-1)?.at ?? new Date().toISOString();
      const ui = turnUiParts({ status: conv.status, collected: conv.collected, awaitingConfirm: out.awaitingConfirm, suiteId: conv.suiteId, cost }, `t${Date.parse(at) || Date.now()}`);
      if (ui.length) await store.update(conv.id, { transcript: withLastAgentUi(conv.transcript as ChatTranscriptEntry[], ui) });
      return { reply: out.reply, conversationId: conv.id, status: conv.status, ui };
    },
  });
  return createUIMessageStreamResponse({ stream });
}

const ADVANCE_EVERY_SEC = 10;

async function maybeAdvance(customerId: string, conv: ConversationRow): Promise<ConversationRow> {
  if (conv.status !== "building" && conv.status !== "running") return conv;
  const gate = await rateLimit(`sandbox-assistant-advance:${conv.id}`, 1, ADVANCE_EVERY_SEC);
  if (!gate.ok) return conv;
  try {
    await advanceOnboardingConversation(customerId, conv.id);
  } catch (err) {
    console.error("sandbox assistant advance failed", err instanceof Error ? err.message : err);
  }
  return (await drizzleOnboardingStore().getConversation(conv.id)) ?? conv;
}

/**
 * The signed-in customer's latest chat conversation as UIMessages (generative parts hydrated from the live draft/run).
 * `?advance=1` (the client's poll while a build or run is open) also moves that conversation forward.
 */
export async function GET(req: Request) {
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const store = drizzleOnboardingStore();
  let conv = await store.latestForCustomer(auth.viewer.id, "chat");
  if (!conv) return Response.json({ conversationId: null, status: "collecting", messages: [] });
  if (new URL(req.url).searchParams.get("advance") === "1") conv = await maybeAdvance(auth.viewer.id, conv);
  const transcript = conv.transcript as ChatTranscriptEntry[];
  // Terminal states no longer change, so pin the implied run parts onto the transcript (keeps them after a new round).
  const implied = impliedLiveParts({ ...conv, transcript });
  if (implied.length && (conv.status === "reported" || conv.status === "blocked")) {
    const next = withLastAgentUi(transcript, implied);
    await store.update(conv.id, { transcript: next }).catch(() => {});
    conv = { ...conv, transcript: next };
  }
  const messages = await hydrateMessages({ ...conv, transcript: conv.transcript as ChatTranscriptEntry[] }, sources(auth.viewer.id));
  return Response.json({ conversationId: conv.id, status: conv.status, messages });
}
