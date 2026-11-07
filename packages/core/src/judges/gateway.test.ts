import { describe, expect, it, vi } from 'vitest';
import { createGatewayJudge, JudgeUnavailableError } from './gateway';

const input = { operationId: 'op1', rubric: 'Be polite', response: 'Go away.' };
const verdict = { outcome: 'rubric_concern', explanation: 'Dismissive wording.', evidenceQuotes: ['Go away.'] };
function setup(body: unknown = verdict) {
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(body) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } })));
  const authorize = vi.fn(async () => {});
  const recordUsage = vi.fn(async () => {});
  return { request, authorize, recordUsage, judge: createGatewayJudge({ model: 'configured/model', token: async () => 'private-test-token', authorize, recordUsage, fetch: request }) };
}
describe('Gateway rubric judge', () => {
  it('validates evidence and records usage without inventing dollar cost', async () => {
    const s = setup();
    expect(await s.judge(input)).toEqual(verdict);
    expect(s.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ promptTokens: 20, costMicroUsd: null, source: 'ai_gateway' }));
    expect(s.request.mock.calls[0]?.[0]).toBe('https://ai-gateway.vercel.sh/v1/chat/completions');
  });
  it('does not assess factual correctness or spend without references', async () => {
    const s = setup();
    expect((await s.judge({ ...input, assessesFactualCorrectness: true })).outcome).toBe('inconclusive');
    expect(s.authorize).not.toHaveBeenCalled();
    expect(s.request).not.toHaveBeenCalled();
  });
  it.each([{ ...verdict, outcome: 'confirmed' }, { ...verdict, evidenceQuotes: ['invented quote'] }, { ...verdict, evidenceQuotes: [] }, { ...verdict, confidence: 0.99 }])('rejects invalid judgments but retains usage', async (body) => {
    const s = setup(body);
    await expect(s.judge(input)).rejects.toBeInstanceOf(JudgeUnavailableError);
    expect(s.recordUsage).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch when budget authorization fails', async () => {
    const s = setup(); s.authorize.mockRejectedValueOnce(new Error('budget exhausted'));
    await expect(s.judge(input)).rejects.toThrow('budget exhausted');
    expect(s.request).not.toHaveBeenCalled();
  });
  it('does not leak provider errors or retry ambiguous requests', async () => {
    const s = setup(); s.request.mockRejectedValueOnce(new Error('private-test-token leaked by provider'));
    await expect(s.judge(input)).rejects.toThrow('Rubric judge unavailable');
    expect(s.request).toHaveBeenCalledTimes(1);
    expect(s.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ result: 'unknown', costMicroUsd: null }));
  });
  it('rejects oversized responses', async () => {
    const s = setup(); s.request.mockResolvedValueOnce(new Response('x'.repeat(65 * 1024)));
    await expect(s.judge(input)).rejects.toBeInstanceOf(JudgeUnavailableError);
  });
  it.each(['length', 'content_filter', 'tool_calls'])('retains usage for a rejected %s completion', async (reason) => {
    const s = setup();
    s.request.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'gen-test-1', choices: [{ finish_reason: reason, message: { content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 12, completion_tokens: 6 } })));
    await expect(s.judge(input)).rejects.toBeInstanceOf(JudgeUnavailableError);
    expect(s.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ providerResponseId: 'gen-test-1', promptTokens: 12, completionTokens: 6, result: 'received', costMicroUsd: null }));
  });
  it('rejects refusals even when structured content looks valid', async () => {
    const s = setup();
    s.request.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(verdict), refusal: 'refused' } }] })));
    await expect(s.judge(input)).rejects.toBeInstanceOf(JudgeUnavailableError);
  });
  it('does not return a verdict when recording usage fails', async () => {
    const s = setup(); s.recordUsage.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(s.judge(input)).rejects.toThrow('storage unavailable');
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it('records absent token usage as unknown rather than zero', async () => {
    const s = setup();
    s.request.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(verdict) } }] })));
    await s.judge(input);
    expect(s.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ promptTokens: null, completionTokens: null, costMicroUsd: null }));
  });
});
