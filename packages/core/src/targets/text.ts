import { platformTarget, type PlatformTarget } from './adapters.js';
import type { ChatMessage } from './chat.js';
import { TargetError, type JsonTransport } from './transport.js';

export interface TextRequest {
  scenarioId: string;
  runId: string;
  systemPrompt: string | null;
  userMessage: string;
}
export type TextResponse =
  | { ok: true; text: string; latencyMs: number }
  | { ok: false; errorCode: string; message: string; latencyMs: number };

/** Credentials stay in this closure; scenario/run IDs are local evidence metadata, not provider input. */
export function createTextTarget(endpoint: PlatformTarget, transport?: JsonTransport): {
  send(request: TextRequest): Promise<TextResponse>;
} {
  const client = platformTarget(endpoint, transport);
  return {
    async send(request) {
      const started = performance.now();
      const elapsed = () => Math.max(0, Math.round(performance.now() - started));
      const messages: ChatMessage[] = [];
      // The frozen scenario's prompt is authoritative, including explicit null.
      if (request.systemPrompt !== null) messages.push({ role: 'system', content: request.systemPrompt });
      messages.push({ role: 'user', content: request.userMessage });
      try {
        const answer = await client.complete(messages);
        if (answer.tool_calls?.length) throw new TargetError('unexpected_tool_calls');
        if (typeof answer.content !== 'string' || !answer.content.length) throw new TargetError('invalid_completion');
        return { ok: true, text: answer.content, latencyMs: elapsed() };
      } catch (error) {
        // Never expose provider error bodies, URLs, credentials, or arbitrary thrown messages.
        return { ok: false, errorCode: error instanceof TargetError ? error.code : 'target_error', message: 'Target request did not produce a complete text response.', latencyMs: elapsed() };
      }
    },
  };
}
