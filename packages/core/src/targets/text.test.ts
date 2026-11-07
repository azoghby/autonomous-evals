import { expect, it, vi } from 'vitest';
import { createTextTarget } from './text.js';
import { TargetError } from './transport.js';

const endpoint = { url: 'https://target.example/v1/chat/completions', model: 'test', apiKey: 'private-test-key', systemPrompt: 'old prompt' };
const request = { scenarioId: 'scenario-local', runId: 'run-local', systemPrompt: 'frozen prompt', userMessage: 'hello' };
const completion = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

it('sends only frozen messages through the secure client and keeps credential/metadata out of the body', async () => {
  const post = vi.fn().mockResolvedValue(completion('world'));
  const response = await createTextTarget(endpoint, { post }).send(request);
  expect(response).toMatchObject({ ok: true, text: 'world' });
  expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  expect(post).toHaveBeenCalledWith(endpoint.url, {
    model: 'test', messages: [{ role: 'system', content: 'frozen prompt' }, { role: 'user', content: 'hello' }],
    max_completion_tokens: 1024, store: false,
  }, endpoint.apiKey);
  expect(JSON.stringify(post.mock.calls[0]![1])).not.toContain(endpoint.apiKey);
});
it('honors a frozen null system prompt instead of silently using endpoint defaults', async () => {
  const post = vi.fn().mockResolvedValue(completion('world'));
  await createTextTarget(endpoint, { post }).send({ ...request, systemPrompt: null });
  expect(post.mock.calls[0]![1].messages).toEqual([{ role: 'user', content: 'hello' }]);
});
it.each([
  { choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }] },
  { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'create_event', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
  { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] },
])('never treats incomplete text or unsolicited tool calls as a successful text evaluation', async raw => {
  expect(await createTextTarget(endpoint, { post: async () => raw }).send(request)).toMatchObject({ ok: false });
});
it.each([new Error('private-test-key provider body'), new TargetError('request_timeout')])('returns safe errors without provider exception text', async error => {
  const response = await createTextTarget(endpoint, { post: async () => { throw error; } }).send(request);
  expect(response).toMatchObject({ ok: false, errorCode: error instanceof TargetError ? 'request_timeout' : 'target_error' });
  expect(JSON.stringify(response)).not.toContain(endpoint.apiKey);
});
