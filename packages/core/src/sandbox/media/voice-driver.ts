/**
 * Voice turn adapters.
 *
 * Implemented now: `ChatAudioVoiceDriver` — one request per turn to an OpenAI chat/completions-style endpoint that
 * accepts `input_audio` content parts and may return `message.audio` ({ data, transcript }) when asked for
 * `modalities: ["text","audio"]`. If the agent returns audio without a transcript, we transcribe it via the gateway.
 * Timing is whole-response (non-streaming), so TTFA here is an upper bound.
 *
 * Week-1 (typed only): `RealtimeVoiceTransport` for IntegrationMode "realtime_voice" (openai_realtime, gemini_live,
 * pipecat, livekit, custom_pcm) — full-duplex PCM streaming, barge-in, true time-to-first-audio.
 */
import type { IntegrationMode } from "../spec";
import type { MediaGateway } from "./client";
import { transcribeAudio } from "./stt";
import type { TurnTiming } from "./perception";

export interface VoiceToolCall { id: string; name: string; arguments: string }
export interface VoiceTurnResult {
  agentText: string;
  agentAudio?: { bytes: Uint8Array; format: string };
  /** Where agentText came from. */
  textSource: "content" | "audio_transcript" | "stt" | "none";
  toolCalls: VoiceToolCall[];
  timing: TurnTiming;
  /** Raw assistant message, appended to history for the next turn. */
  assistantMessage: Record<string, unknown>;
}

export interface VoiceTurnDriver {
  /** Send one user turn (audio bytes) and get the agent's reply. History is owned by the driver. */
  sendUserAudio(audio: Uint8Array, format: "wav" | "mp3", turn: number): Promise<VoiceTurnResult>;
  /** Feed tool results back (tool_loop mode) and get the agent's follow-up. */
  sendToolResults(results: Array<{ toolCallId: string; content: string }>, turn: number): Promise<VoiceTurnResult>;
}

export interface ChatAudioDriverOptions {
  endpointUrl: string;
  model: string;
  /** Resolved secret (never from the spec). */
  apiKey?: string;
  systemPrompt?: string;
  tools?: unknown[];
  /** Request audio output from the agent. Default true. */
  wantAudio?: boolean;
  outputVoice?: string;
  outputFormat?: "wav" | "mp3" | "pcm16";
  /** For STT of audio-only replies. */
  gateway?: MediaGateway;
  sttModel?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface ChatMessage { role: string; content?: unknown; audio?: { data?: string; transcript?: string; id?: string }; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }

const toB64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

export class ChatAudioVoiceDriver implements VoiceTurnDriver {
  private readonly history: Array<Record<string, unknown>> = [];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly o: ChatAudioDriverOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? (() => performance.now());
    if (o.systemPrompt) this.history.push({ role: "system", content: o.systemPrompt });
  }

  sendUserAudio(audio: Uint8Array, format: "wav" | "mp3", turn: number): Promise<VoiceTurnResult> {
    this.history.push({ role: "user", content: [{ type: "input_audio", input_audio: { data: toB64(audio), format } }] });
    return this.complete(turn);
  }

  sendToolResults(results: Array<{ toolCallId: string; content: string }>, turn: number): Promise<VoiceTurnResult> {
    for (const r of results) this.history.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
    return this.complete(turn);
  }

  private async complete(turn: number): Promise<VoiceTurnResult> {
    const wantAudio = this.o.wantAudio ?? true;
    const body = {
      model: this.o.model,
      messages: this.history,
      ...(this.o.tools?.length ? { tools: this.o.tools } : {}),
      ...(wantAudio ? { modalities: ["text", "audio"], audio: { voice: this.o.outputVoice ?? "alloy", format: this.o.outputFormat ?? "wav" } } : {}),
    };
    const userEndMs = this.now();
    const res = await this.fetchImpl(this.o.endpointUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
    });
    const endMs = this.now();
    if (!res.ok) throw new Error(`voice agent HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices?: Array<{ message?: ChatMessage }> };
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new Error("voice agent returned no choices[0].message");

    // Keep audio by id when the API provides one (OpenAI multi-turn audio), else keep the transcript as text.
    const assistantMessage: Record<string, unknown> = {
      role: "assistant",
      content: typeof msg.content === "string" ? msg.content : msg.audio?.transcript ?? null,
      ...(msg.audio?.id ? { audio: { id: msg.audio.id } } : {}),
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    };
    this.history.push(assistantMessage);

    const agentAudio = msg.audio?.data ? { bytes: new Uint8Array(Buffer.from(msg.audio.data, "base64")), format: this.o.outputFormat ?? "wav" } : undefined;
    const { text, source } = await this.replyText(msg, agentAudio);
    return {
      agentText: text,
      agentAudio,
      textSource: source,
      toolCalls: (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
      timing: { turn, userEndMs, agentEndMs: endMs, agentFirstTokenMs: endMs, ...(agentAudio ? { agentFirstAudioMs: endMs } : {}) },
      assistantMessage,
    };
  }

  private async replyText(msg: ChatMessage, audio?: { bytes: Uint8Array }): Promise<{ text: string; source: VoiceTurnResult["textSource"] }> {
    if (typeof msg.content === "string" && msg.content.trim()) return { text: msg.content, source: "content" };
    if (msg.audio?.transcript) return { text: msg.audio.transcript, source: "audio_transcript" };
    if (audio && this.o.gateway) {
      const t = await transcribeAudio(this.o.gateway, audio.bytes, { model: this.o.sttModel });
      return { text: t.text, source: "stt" };
    }
    return { text: "", source: "none" };
  }
}

/* ---------------- realtime (week-1) ---------------- */

export type RealtimeProtocol = Extract<IntegrationMode, { mode: "realtime_voice" }>["protocol"];

export type RealtimeEvent =
  | { type: "agent_audio"; pcm: Int16Array; atMs: number }
  | { type: "agent_transcript"; text: string; final: boolean; atMs: number }
  | { type: "agent_tool_call"; id: string; name: string; arguments: string; atMs: number }
  | { type: "agent_turn_end"; atMs: number }
  | { type: "error"; message: string; atMs: number };

/**
 * Full-duplex transport for `realtime_voice`. TODO(week-1): implement per protocol
 *  - openai_realtime: wss, session.update + input_audio_buffer.append/commit, response.audio.delta
 *  - gemini_live: BidiGenerateContent realtimeInput.audio / serverContent.modelTurn
 *  - pipecat / livekit: room join + track publish (likely needs the Vercel Sandbox worker)
 *  - custom_pcm: raw 16-bit PCM frames at sampleRateHz
 * Barge-in (persona.voice.interrupts) = pushUserAudio while agent audio is still streaming; talk-over and silence
 * handling graders consume the RealtimeEvent timeline.
 */
export interface RealtimeVoiceTransport {
  readonly protocol: RealtimeProtocol;
  connect(opts: { wsUrl: string; sampleRateHz: number; apiKey?: string }): Promise<void>;
  /** Stream simulated-user PCM; `final` marks end of the user utterance. */
  pushUserAudio(pcm: Int16Array, final: boolean): void;
  events(): AsyncIterable<RealtimeEvent>;
  sendToolResult(id: string, content: string): void;
  close(): Promise<void>;
}

export function createRealtimeTransport(protocol: RealtimeProtocol): RealtimeVoiceTransport {
  throw new Error(`realtime_voice transport "${protocol}" is not implemented yet (week-1); use ChatAudioVoiceDriver for chat-completions audio agents`);
}
