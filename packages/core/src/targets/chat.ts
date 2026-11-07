import { z } from 'zod';
import { HttpsJsonTransport, TargetError, type JsonTransport } from './transport.js';

/** PostgreSQL text/jsonb cannot store NUL or unpaired UTF-16 surrogates. */
export const isPersistableText = (value: string) => !/[\u0000\uD800-\uDFFF]/u.test(value);
export const toolCallSchema = z.object({
  id: z.string().min(1).max(128).refine(isPersistableText), type: z.literal('function'),
  function: z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), arguments: z.string().max(32_000).refine(isPersistableText) }),
});
export const assistantSchema = z.object({
  role: z.literal('assistant'), content: z.string().max(128_000).refine(isPersistableText).nullable().optional(),
  tool_calls: z.array(toolCallSchema).max(8).optional(),
}).superRefine((m, ctx) => {
  if (!m.content && !m.tool_calls?.length) ctx.addIssue({ code: 'custom', message: 'empty assistant response' });
  if (new Set(m.tool_calls?.map(t => t.id)).size !== (m.tool_calls?.length ?? 0)) ctx.addIssue({ code: 'custom', message: 'duplicate tool ids' });
});
const completionSchema = z.object({ choices: z.array(z.object({
  message: assistantSchema, finish_reason: z.enum(['stop', 'tool_calls', 'length', 'content_filter']),
})).length(1), usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() }).optional() });
export type AssistantMessage = z.infer<typeof assistantSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export type ChatMessage = { role: 'system' | 'user'; content: string } | AssistantMessage | { role: 'tool'; tool_call_id: string; content: string };
export interface FunctionTool { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface TargetConfig { endpoint: string; model: string; bearer?: string }
export interface ChatTarget { complete(messages: ChatMessage[], tools?: FunctionTool[]): Promise<AssistantMessage> }
export class ChatCompletionsClient implements ChatTarget {
  constructor(private readonly config: TargetConfig, private readonly transport: JsonTransport = new HttpsJsonTransport()) {
    if (!config.model || config.model.length > 200) throw new TargetError('invalid_model');
  }
  async complete(messages: ChatMessage[], tools?: FunctionTool[]): Promise<AssistantMessage> {
    return this.send(messages, tools, 1024);
  }
  private async send(messages: ChatMessage[], tools: FunctionTool[] | undefined, maxCompletionTokens: number): Promise<AssistantMessage> {
    const raw = await this.transport.post(this.config.endpoint, {
      model: this.config.model, messages, max_completion_tokens: maxCompletionTokens, store: false,
      ...(tools?.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
    }, this.config.bearer);
    const result = completionSchema.safeParse(raw);
    if (!result.success) throw new TargetError('invalid_completion');
    const choice = result.data.choices[0]!;
    if (choice.finish_reason !== (choice.message.tool_calls?.length ? 'tool_calls' : 'stop')) throw new TargetError('incomplete_completion');
    return choice.message;
  }
  async checkTarget(): Promise<{ connected: true }> {
    await this.send([{ role: 'user', content: 'Reply OK.' }], undefined, 16);
    return { connected: true };
  }
}
export async function checkTarget(config: TargetConfig, transport?: JsonTransport) {
  return new ChatCompletionsClient(config, transport).checkTarget();
}
