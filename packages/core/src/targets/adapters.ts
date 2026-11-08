import { ChatCompletionsClient, type TargetConfig } from './chat';
import { HttpsJsonTransport, TargetError, type JsonTransport } from './transport';
/** Structurally compatible with Track A endpoint contracts; no contract import required. */
export interface PlatformTarget { url: string; model: string; apiKey?: string; systemPrompt?: string; maxCompletionTokens?: number }
export function targetConfig(input: PlatformTarget): TargetConfig {
  return { endpoint: input.url, model: input.model, bearer: input.apiKey, maxCompletionTokens: input.maxCompletionTokens };
}
export function platformTarget(input: PlatformTarget, transport?: JsonTransport) {
  return new ChatCompletionsClient(targetConfig(input), transport);
}
export function createTargetServices(transport: JsonTransport = new HttpsJsonTransport()) {
  return {
    async checkTarget(_ctx: unknown, endpoint: PlatformTarget): Promise<{ ok: boolean; detail: string }> {
      try { await platformTarget(endpoint, transport).checkTarget(); return { ok: true, detail: 'Connected to Chat Completions endpoint.' }; }
      catch (e) { return { ok: false, detail: e instanceof TargetError ? e.code : 'connection_failed' }; }
    },
  };
}
