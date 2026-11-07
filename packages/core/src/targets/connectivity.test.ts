import { expect, it, vi } from 'vitest';
import { ChatCompletionsClient } from './chat';
import type { JsonTransport } from './transport';

const config = { endpoint: 'https://fixture.example/v1/chat/completions', model: 'configured/reasoning' };
it('accepts a truncated reasoning probe without accepting a truncated evaluation', async () => {
  const transport: JsonTransport = { post: vi.fn(async () => ({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }] })) };
  const client = new ChatCompletionsClient(config, transport);
  await expect(client.checkTarget()).resolves.toEqual({ connected: true });
  await expect(client.complete([{ role: 'user', content: 'Evaluate this' }])).rejects.toThrow();
});
it.each([{ choices: [] }, { choices: [{ finish_reason: 'length', message: { role: 'user', content: '' } }] }, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }] }])('rejects malformed probes', async response => {
  await expect(new ChatCompletionsClient(config, { post: async () => response }).checkTarget()).rejects.toThrow();
});
it('keeps the connection probe small while honoring an explicit evaluation cap', async () => {
  const post = vi.fn(async (_endpoint: string, _body: unknown) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] }));
  const client = new ChatCompletionsClient({ ...config, maxCompletionTokens: 25_000 }, { post });
  await client.checkTarget(); await client.complete([{ role: 'user', content: 'Evaluate' }]);
  expect(post.mock.calls[0][1]).toMatchObject({ max_completion_tokens: 16 });
  expect(post.mock.calls[1][1]).toMatchObject({ max_completion_tokens: 25_000 });
});
it.each([0, -1, 1.5, 32_769, NaN])('rejects invalid token cap %s', maxCompletionTokens => {
  expect(() => new ChatCompletionsClient({ ...config, maxCompletionTokens })).toThrow('invalid_token_limit');
});
