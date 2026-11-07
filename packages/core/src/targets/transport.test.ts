import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
const harness = vi.hoisted(() => ({ options: undefined as any, calls: 0, mode: 'ok', body: '', active: 0, peak: 0 }));
vi.mock('node:https', () => ({ request: (options: any, callback: any) => {
  harness.options = options; harness.calls++; harness.active++; harness.peak = Math.max(harness.peak, harness.active);
  const req = new EventEmitter() as any;
  req.end = (body: string) => {
    harness.body = body;
    if (harness.mode === 'hang') return;
    queueMicrotask(() => {
      const res = new EventEmitter() as any;
      res.statusCode = harness.mode === 'redirect' ? 302 : 200;
      res.headers = {};
      res.destroy = () => { harness.active--; };
      callback(res);
      if (res.statusCode === 200) { res.emit('data', Buffer.from(harness.mode === 'large' ? 'x'.repeat(100) : '{"ok":true}')); res.emit('end'); harness.active--; }
    });
  };
  options.signal.addEventListener('abort', () => { harness.active--; req.emit('error', new Error('secret should never leak')); });
  return req;
} }));
import { HttpsJsonTransport, isPublicAddress, resolvePublic, targetUrl, TargetGate } from './transport.js';
import { ChatCompletionsClient } from './chat.js';
const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];
beforeEach(() => { harness.calls = 0; harness.mode = 'ok'; harness.active = 0; harness.peak = 0; });
describe('SSRF policy', () => {
  it.each(['127.0.0.1','0.0.0.0','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','192.0.2.1','198.18.0.1','198.51.100.2','203.0.113.1','224.1.1.1','240.1.1.1','::','::1','fc00::1','fe80::1','ff02::1','2001:db8::1','2001::1','2002:0808:0808::','64:ff9b::a00:1','::ffff:127.0.0.1','::ffff:8.8.8.8','3fff::1','fe80::1%lo0'])('blocks %s', ip => expect(isPublicAddress(ip)).toBe(false));
  it.each(['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])('allows %s', ip => expect(isPublicAddress(ip)).toBe(true));
  it.each(['https://2130706433/v1','https://0x7f000001/v1','https://0177.0.0.1/v1','https://[::ffff:7f00:1]/v1'])('blocks URL normalization bypass %s', async url => { const t = new HttpsJsonTransport(); await expect(t.post(url, {})).rejects.toThrow('blocked_address'); expect(harness.calls).toBe(0); });
  it.each(['http://example.com','https://user:pass@example.com','https://example.com:444','https://example.com#x','https://example.com?key=secret'])('rejects %s', url => expect(() => targetUrl(url)).toThrow());
  it('blocks all mixed DNS answers and forged families', async () => {
    await expect(resolvePublic('target.test', async () => [...await publicDns(), { address: '127.0.0.1', family: 4 }])).rejects.toThrow('blocked_address');
    await expect(resolvePublic('target.test', async () => [{ address: '8.8.8.8', family: 6 }])).rejects.toThrow();
  });
  it('pins the validated address; no connection-time re-resolution is possible', async () => {
    const dns = vi.fn().mockResolvedValueOnce(await publicDns()).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const t = new HttpsJsonTransport({ resolver: dns });
    await t.post('https://target.test/v1/chat/completions', {}, 'credential');
    expect(dns).toHaveBeenCalledTimes(1);
    expect(harness.options).toMatchObject({ hostname: '8.8.8.8', servername: 'target.test', agent: false, rejectUnauthorized: true });
    expect(harness.options.headers.Host).toBe('target.test');
    expect(harness.options.lookup).toBeUndefined();
    expect(typeof harness.options.checkServerIdentity).toBe('function');
    await expect(t.post('https://target.test/v1/chat/completions', {})).rejects.toThrow('blocked_address');
  });
});
describe('transport bounds', () => {
  it('never follows redirects or reflects provider errors', async () => { harness.mode = 'redirect'; await expect(new HttpsJsonTransport({ resolver: publicDns }).post('https://target.test/v1', {})).rejects.toThrow('provider_http_error'); expect(harness.calls).toBe(1); });
  it('caps request and response bytes', async () => {
    await expect(new HttpsJsonTransport({ maxRequestBytes: 2 }).post('https://target.test', { huge: true })).rejects.toThrow('request_too_large');
    harness.mode = 'large'; await expect(new HttpsJsonTransport({ resolver: publicDns, maxResponseBytes: 20 }).post('https://target.test', {})).rejects.toThrow('response_too_large');
  });
  it('deadline includes hung DNS and releases admission', async () => {
    const gate = new TargetGate(); const t = new HttpsJsonTransport({ timeoutMs: 10, gate, resolver: () => new Promise(() => {}) });
    await expect(t.post('https://target.test', {})).rejects.toThrow('timeout');
    await expect(new HttpsJsonTransport({ gate, resolver: publicDns }).post('https://target.test', {})).resolves.toEqual({ ok: true });
  });
  it('limits requests to two and aborts hung sockets', async () => {
    harness.mode = 'hang'; const t = new HttpsJsonTransport({ resolver: publicDns, timeoutMs: 20 });
    const a = t.post('https://target.test', {}); const b = t.post('https://target.test', {});
    await expect(t.post('https://target.test', {})).rejects.toThrow('target_busy');
    await expect(a).rejects.toThrow('timeout'); await expect(b).rejects.toThrow('timeout'); expect(harness.peak).toBe(2);
  });
  it('omits optional auth, validates secrets without echoing them', async () => {
    const t = new HttpsJsonTransport({ resolver: publicDns }); await t.post('https://target.test', {});
    expect(harness.options.headers.Authorization).toBeUndefined();
    await expect(t.post('https://target.test', {}, 'secret\r\nx')).rejects.toThrow('invalid_credential');
  });
});
describe('chat validation', () => {
  it.each([
    { role: 'assistant', content: null },
    { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'create_event', arguments: {} } }] },
    { role: 'assistant', content: null, tool_calls: [1] },
  ])('rejects malformed provider output', async message => {
    const c = new ChatCompletionsClient({ endpoint: 'https://target.test', model: 'test' }, { post: async () => ({ choices: [{ message, finish_reason: 'stop' }] }) });
    await expect(c.complete([])).rejects.toThrow('invalid_completion');
  });
  it('minimal check has no tools and bounded tokens; accepts text', async () => {
    const post = vi.fn().mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
    const c = new ChatCompletionsClient({ endpoint: 'https://target.test/v1/chat/completions', model: 'test' }, { post });
    await expect(c.checkTarget()).resolves.toEqual({ connected: true });
    expect(post.mock.calls[0][1]).toMatchObject({ max_completion_tokens: 16, store: false }); expect(post.mock.calls[0][1].tools).toBeUndefined();
  });
});
