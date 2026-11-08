import "server-only";
/**
 * Writes one Nova turn as an AI SDK UI message stream: a transient "thinking" status while the onboarding agent works,
 * the reply as text deltas, then each generative component as a typed tool part (input-available -> output/error).
 */
import { createUIMessageStream, type UIMessageStreamWriter } from "ai";
import type { NovaUIMessage, StoredUiPart } from "@/components/chat/nova-types";
import { toolPartFor, type LiveSources } from "./onboarding-chat";

export interface TurnResult {
  reply: string;
  conversationId: string;
  status: string;
  /** Parts already persisted on the agent entry (live ones are references). */
  ui: StoredUiPart[];
}

const pause = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Splits a reply into word-ish chunks so the client can reveal it progressively. */
export function chunkReply(text: string, size = 3): string[] {
  const tokens = text.match(/\S+\s*/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += size) out.push(tokens.slice(i, i + size).join(""));
  const lead = text.match(/^\s+/)?.[0];
  return lead && out.length ? [lead + out[0], ...out.slice(1)] : out;
}

type Writer = UIMessageStreamWriter<NovaUIMessage>;

async function writeText(writer: Writer, text: string, pacing: number) {
  const id = "reply";
  writer.write({ type: "text-start", id });
  const chunks = chunkReply(text);
  const step = chunks.length ? Math.min(pacing, Math.floor(900 / chunks.length)) : 0;
  for (const delta of chunks) { writer.write({ type: "text-delta", id, delta }); await pause(step); }
  writer.write({ type: "text-end", id });
}

async function writeTool(writer: Writer, p: StoredUiPart, src: LiveSources) {
  writer.write({ type: "tool-input-start", toolCallId: p.id, toolName: p.tool });
  writer.write({ type: "tool-input-available", toolCallId: p.id, toolName: p.tool, input: p.input });
  const part = await toolPartFor(p, src);
  if (part.state === "output-error") writer.write({ type: "tool-output-error", toolCallId: p.id, errorText: part.errorText });
  else if (part.state === "output-available") writer.write({ type: "tool-output-available", toolCallId: p.id, output: part.output });
}

export interface NovaStreamOptions {
  run: () => Promise<TurnResult>;
  src: (r: TurnResult) => LiveSources;
  thinking: string;
  /** Milliseconds between text chunks (0 in tests). */
  pacing?: number;
  onError?: (err: unknown) => string;
}

export function novaTurnStream(o: NovaStreamOptions): ReadableStream {
  return createUIMessageStream<NovaUIMessage>({
    onError: o.onError ?? (() => "Could not process that message."),
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      writer.write({ type: "data-thinking", data: { label: o.thinking }, transient: true });
      const r = await o.run();
      writer.write({ type: "message-metadata", messageMetadata: { conversationId: r.conversationId, status: r.status as NonNullable<NovaUIMessage["metadata"]>["status"] } });
      await writeText(writer, r.reply, o.pacing ?? 28);
      const src = o.src(r);
      for (const p of r.ui) await writeTool(writer, p, src);
      writer.write({ type: "finish" });
    },
  });
}
