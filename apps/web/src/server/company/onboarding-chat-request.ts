/** Request shape + transcript wording for one Nova chat turn (validated in the route; pure, unit-tested). */
import { z } from "zod";
import { MAX_CUSTOMER_TEXT_CHARS } from "@ae/core/company/onboarding";
import { ATTACHMENT_LABEL, ChatAttachment, ChatFields, CHAT_ACTIONS, MAX_ATTACHMENTS, type ChatAttachment as Attachment } from "@/components/chat/nova-types";
import type { OnboardingAttachments } from "./onboarding";

export const ChatTurnBody = z.object({
  message: z.string().trim().max(MAX_CUSTOMER_TEXT_CHARS).default(""),
  conversationId: z.uuid().optional(),
  attachments: z.array(ChatAttachment).max(MAX_ATTACHMENTS).default([]),
  fields: ChatFields.optional(),
  action: z.enum(CHAT_ACTIONS).optional(),
}).refine((b) => b.message.length > 0 || b.attachments.length > 0 || !!b.fields || !!b.action, { message: "Write a message, attach a file or pick an option." });
export type ChatTurnBody = z.infer<typeof ChatTurnBody>;

/** Folds validated attachments into the agent's artifact slots (policies concatenate, the rest take the last file). */
export function toAgentAttachments(files: Attachment[]): OnboardingAttachments {
  const out: OnboardingAttachments = {};
  for (const f of files) {
    if (f.kind === "openapi") out.openapiText = f.content;
    if (f.kind === "tools") out.mcpToolsJson = f.content;
    if (f.kind === "schema") out.dataSample = f.content;
    if (f.kind === "policies") out.policies = [out.policies, f.content].filter(Boolean).join("\n\n");
  }
  return out;
}

/** The customer line stored in the transcript for actions, picker choices and attachments (never file contents). */
export function customerLine(b: ChatTurnBody): string {
  const lines = [b.message];
  if (b.action === "confirm") lines.push("Confirmed the run.");
  if (b.action === "cancel") lines.push("Cancelled the run.");
  if (b.fields?.model) lines.push(`Model: ${b.fields.model}${b.fields.systemPrompt ? " (with a system prompt)" : ""}`);
  else if (b.fields?.systemPrompt) lines.push("Added a system prompt.");
  if (b.fields?.endpointUrl) lines.push(`Endpoint: ${b.fields.endpointUrl}`);
  if (b.fields?.prebuiltWorld) lines.push("Use the Acme sample world.");
  for (const f of b.attachments) lines.push(`[attached: ${f.name} (${ATTACHMENT_LABEL[f.kind]}, ${Math.max(1, Math.round(f.content.length / 1000))} KB)]`);
  return lines.filter(Boolean).join("\n");
}

