/**
 * Target service compatibility with Track A's EvalServices.checkTarget and EndpointConfig.
 * No network, credentials, or cloud resources: transports are injected, and the real transport is only
 * given inputs that it rejects before any DNS lookup or socket.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EndpointConfig } from '../contracts/index';
import type { EvalServices, ServiceContext } from '../contracts/services';
import { HttpsJsonTransport, TargetError, createTargetServices, targetUrl, type JsonTransport } from '../targets/index.js';

// Compile-time compatibility: the target factory must satisfy the exact Track A service shape.
const typedTargetServices: Pick<EvalServices, 'checkTarget'> = createTargetServices();
export type TargetServicesCompatible = typeof typedTargetServices;

// Method-style signatures are bivariant, so also pin variance explicitly: whatever Track A passes must be
// accepted by Track B, and Track B's result must be what Track A expects.
type Assert<T extends true> = T;
type TrackACheck = EvalServices['checkTarget'];
type TargetCheck = ReturnType<typeof createTargetServices>['checkTarget'];
export type TargetVariance = [
  Assert<Parameters<TrackACheck>[0] extends Parameters<TargetCheck>[0] ? true : false>,
  Assert<Parameters<TrackACheck>[1] extends Parameters<TargetCheck>[1] ? true : false>,
  Assert<Awaited<ReturnType<TargetCheck>> extends Awaited<ReturnType<TrackACheck>> ? true : false>,
  Assert<Awaited<ReturnType<TrackACheck>> extends Awaited<ReturnType<TargetCheck>> ? true : false>,
];

const ctx = { jobId: '11111111-1111-4111-8111-111111111111', environment: 'test', budgetMicroUsd: 0, recordCost: async () => {}, recordProgress: async () => {} } satisfies ServiceContext;
const checkResult = z.object({ ok: z.boolean(), detail: z.string().min(1).max(200) }).strict();
const completion = { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] };

class RecordingTransport implements JsonTransport {
  calls: Array<{ endpoint: string; body: unknown; bearer?: string }> = [];
  constructor(private readonly respond: () => unknown | Promise<unknown>) {}
  async post(endpoint: string, body: unknown, bearer?: string) {
    this.calls.push({ endpoint, body, bearer });
    return this.respond();
  }
}

describe('checkTarget service output', () => {
  const endpoint = { url: 'https://provider.example/v1/chat/completions', model: 'm-1', apiKey: 'sk-secret-value' };

  it('returns schema-valid success and forwards only the declared fields to the transport', async () => {
    const transport = new RecordingTransport(() => completion);
    const result = await createTargetServices(transport).checkTarget(ctx, endpoint);
    expect(checkResult.parse(result)).toEqual({ ok: true, detail: 'Connected to Chat Completions endpoint.' });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toMatchObject({ endpoint: endpoint.url, bearer: endpoint.apiKey });
    expect(transport.calls[0]!.body).toMatchObject({ model: 'm-1', max_completion_tokens: 16, store: false });
    expect(JSON.stringify(result)).not.toContain(endpoint.apiKey);
  });

  it('maps transport and malformed-completion failures to short non-secret codes', async () => {
    const cases: Array<[unknown, string]> = [
      [new TargetError('timeout'), 'timeout'],
      [new TargetError('response_too_large'), 'response_too_large'],
      [new Error(`socket failed for ${endpoint.url} using ${endpoint.apiKey}`), 'connection_failed'],
    ];
    for (const [failure, code] of cases) {
      const result = await createTargetServices(new RecordingTransport(() => { throw failure; })).checkTarget(ctx, endpoint);
      expect(checkResult.parse(result)).toEqual({ ok: false, detail: code });
    }
    for (const malformed of [{}, { choices: [] }, { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'length' }] }, 'html', null]) {
      const result = await createTargetServices(new RecordingTransport(() => malformed)).checkTarget(ctx, endpoint);
      expect(checkResult.parse(result).ok).toBe(false);
      expect(result.detail).not.toContain(endpoint.apiKey);
    }
  });

  it('accepts exactly the endpoint fields Track A passes (no systemPrompt required)', async () => {
    const parsed = EndpointConfig.parse({ url: endpoint.url, model: 'm-1', apiKey: 'k' });
    const transport = new RecordingTransport(() => completion);
    expect((await createTargetServices(transport).checkTarget(ctx, { url: parsed.url, model: parsed.model, apiKey: parsed.apiKey })).ok).toBe(true);
  });
});

describe('documented endpoint gaps (Track A schema accepts what the Track B transport refuses)', () => {
  // Pre-payment validation must rely on checkTarget, not on EndpointConfig alone.
  const refused: Array<[string, string]> = [
    ['https://user:pass@provider.example/v1/chat/completions', 'invalid_endpoint'],
    ['https://provider.example:8443/v1/chat/completions', 'invalid_endpoint'],
    ['https://provider.example/v1/chat/completions?api_key=leak', 'invalid_endpoint'],
    ['https://provider.example/v1/chat/completions#fragment', 'invalid_endpoint'],
    ['https://localhost/v1/chat/completions', 'blocked_address'],
    ['https://tenant.localhost/v1/chat/completions', 'blocked_address'],
    ['https://127.0.0.1/v1/chat/completions', 'blocked_address'],
    ['https://10.0.0.5/v1/chat/completions', 'blocked_address'],
    ['https://169.254.169.254/latest/meta-data', 'blocked_address'],
    ['https://[::1]/v1/chat/completions', 'blocked_address'],
    ['https://[::ffff:127.0.0.1]/v1/chat/completions', 'blocked_address'],
    ['https://2130706433/v1/chat/completions', 'blocked_address'],
  ];

  it.each(refused)('KNOWN GAP: EndpointConfig accepts %s but checkTarget refuses it without a network call (%s)', async (url, code) => {
    expect(EndpointConfig.safeParse({ url, model: 'm' }).success).toBe(true);
    // Real transport; every input is rejected before DNS or sockets. A custom resolver would fail the test if consulted.
    const transport = new HttpsJsonTransport({ resolver: async () => { throw new Error('unexpected DNS lookup'); } });
    const result = await createTargetServices(transport).checkTarget(ctx, { url, model: 'm', apiKey: 'sk-secret-value' });
    expect(result).toEqual({ ok: false, detail: code });
  });

  it('KNOWN GAP: apiKey with whitespace or control characters passes the schema but is refused by the transport', async () => {
    const apiKey = 'bad key\n';
    expect(EndpointConfig.safeParse({ url: 'https://provider.example/v1/chat/completions', model: 'm', apiKey }).success).toBe(true);
    const transport = new HttpsJsonTransport({ resolver: async () => { throw new Error('unexpected DNS lookup'); } });
    const result = await createTargetServices(transport).checkTarget(ctx, { url: 'https://provider.example/v1/chat/completions', model: 'm', apiKey });
    expect(result).toEqual({ ok: false, detail: 'invalid_credential' });
  });

  it('refuses http, which the schema also rejects (the two layers agree here)', () => {
    expect(EndpointConfig.safeParse({ url: 'http://provider.example/v1/chat/completions', model: 'm' }).success).toBe(false);
    expect(() => targetUrl('http://provider.example/v1/chat/completions')).toThrow(TargetError);
  });

  it('KNOWN GAP: a bare provider origin passes the schema; the target service never guesses a Chat Completions path', async () => {
    const url = 'https://provider.example';
    expect(EndpointConfig.safeParse({ url, model: 'm' }).success).toBe(true);
    const transport = new RecordingTransport(() => completion);
    await createTargetServices(transport).checkTarget(ctx, { url, model: 'm' });
    expect(transport.calls[0]!.endpoint).toBe(url);
  });
});
