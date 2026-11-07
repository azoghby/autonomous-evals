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
      res.headers = harness.mode === 'encoding' ? { 'content-encoding': 'gzip' } : {};
      res.destroy = () => { harness.active--; };
      callback(res);
      if (res.statusCode === 200) { res.emit('data', Buffer.from(harness.mode === 'large' ? 'x'.repeat(100) : harness.mode === 'invalid' ? '{' : '{"ok":true}')); res.emit('end'); harness.active--; }
    });
  };
  options.signal.addEventListener('abort', () => { harness.active--; req.emit('error', new Error('secret should never leak')); });
  return req;
} }));
import { isPublicAddress, resolvePublic, targetUrl, TargetGate } from './transport';
import { HttpsPublicSourceTransport, publicSourceUrl } from './public-source';
const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];
beforeEach(() => { harness.calls = 0; harness.mode = 'ok'; harness.active = 0; harness.peak = 0; });
describe('SSRF policy', () => {
  it.each(['127.0.0.1','0.0.0.0','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','192.0.2.1','198.18.0.1','198.51.100.2','203.0.113.1','224.1.1.1','240.1.1.1','::','::1','fc00::1','fe80::1','ff02::1','2001:db8::1','2001::1','2002:0808:0808::','64:ff9b::a00:1','::ffff:127.0.0.1','::ffff:8.8.8.8','3fff::1','fe80::1%lo0'])('blocks %s', ip => expect(isPublicAddress(ip)).toBe(false));
  it.each(['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])('allows %s', ip => expect(isPublicAddress(ip)).toBe(true));
  it.each(['https://127.0.0.1/v1','https://0x7f000001/v1','https://0177.0.0.1/v1','https://[::ffff:7f00:1]/v1'])('blocks URL normalization bypass %s', async url => { const t = new HttpsPublicSourceTransport(new URL(url).origin); await expect(t.get(url)).rejects.toThrow('blocked_address'); expect(harness.calls).toBe(0); });
  it.each(['http://example.com','https://user:pass@example.com','https://example.com:444','https://example.com#x','https://example.com?key=secret'])('rejects %s', url => expect(() => targetUrl(url)).toThrow());
  it('blocks all mixed DNS answers and forged families', async () => {
    await expect(resolvePublic('target.test', async () => [...await publicDns(), { address: '127.0.0.1', family: 4 }])).rejects.toThrow('blocked_address');
    await expect(resolvePublic('target.test', async () => [{ address: '8.8.8.8', family: 6 }])).rejects.toThrow();
  });
  it('pins the validated address; no connection-time re-resolution is possible', async () => {
    const dns = vi.fn().mockResolvedValueOnce(await publicDns()).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const t = new HttpsPublicSourceTransport('https://target.test', { resolver: dns });
    await t.get('https://target.test/v1/chat/completions?q=search');
    expect(dns).toHaveBeenCalledTimes(1);
    expect(harness.options).toMatchObject({ hostname: '8.8.8.8', servername: 'target.test', agent: false, rejectUnauthorized: true });
    expect(harness.options.headers.Host).toBe('target.test');
    expect(harness.options.lookup).toBeUndefined();
    expect(typeof harness.options.checkServerIdentity).toBe('function');
    await expect(t.get('https://target.test/v1/chat/completions?q=search')).rejects.toThrow('blocked_address');
  });
});
describe('transport bounds', () => {
  it('never follows redirects or reflects provider errors', async () => { harness.mode = 'redirect'; await expect(new HttpsPublicSourceTransport('https://target.test', { resolver: publicDns }).get('https://target.test/v1')).rejects.toThrow('provider_http_error'); expect(harness.calls).toBe(1); });
  it.each(['encoding', 'invalid'])('rejects unsupported or malformed body: %s', async mode => {
    harness.mode = mode;
    await expect(new HttpsPublicSourceTransport('https://target.test', { resolver: publicDns }).get('https://target.test')).rejects.toThrow(mode === 'encoding' ? 'unsupported_encoding' : 'invalid_json');
  });
  it('does not open a socket after DNS resolves past the deadline', async () => {
    let release!: (value: Array<{ address: string; family: number }>) => void;
    const dns = () => new Promise<Array<{ address: string; family: number }>>(resolve => { release = resolve; });
    await expect(new HttpsPublicSourceTransport('https://target.test', { resolver: dns, timeoutMs: 5 }).get('https://target.test')).rejects.toThrow('timeout');
    release(await publicDns());
    await Promise.resolve();
    expect(harness.calls).toBe(0);
  });
  it('caps request and response bytes', async () => {
    await expect(new HttpsPublicSourceTransport('https://target.test', { maxRequestBytes: 2 }).get('https://target.test/large?query=x')).rejects.toThrow('request_too_large');
    harness.mode = 'large'; await expect(new HttpsPublicSourceTransport('https://target.test', { resolver: publicDns, maxResponseBytes: 20 }).get('https://target.test')).rejects.toThrow('response_too_large');
  });
  it('deadline includes hung DNS and releases admission', async () => {
    const gate = new TargetGate(); const t = new HttpsPublicSourceTransport('https://target.test', { timeoutMs: 10, gate, resolver: () => new Promise(() => {}) });
    await expect(t.get('https://target.test')).rejects.toThrow('timeout');
    await expect(new HttpsPublicSourceTransport('https://target.test', { gate, resolver: publicDns }).get('https://target.test')).resolves.toEqual({ ok: true });
  });
  it('limits requests to two and aborts hung sockets', async () => {
    harness.mode = 'hang'; const t = new HttpsPublicSourceTransport('https://target.test', { resolver: publicDns, timeoutMs: 20 });
    const a = t.get('https://target.test'); const b = t.get('https://target.test');
    await expect(t.get('https://target.test')).rejects.toThrow('target_busy');
    await expect(a).rejects.toThrow('timeout'); await expect(b).rejects.toThrow('timeout'); expect(harness.peak).toBe(2);
  });
  it('allows bounded queries only on configured origin, while POST policy stays strict', async () => {
    const t = new HttpsPublicSourceTransport('https://target.test', { resolver: publicDns });
    await t.get('https://target.test/w/api.php?q=test');
    expect(harness.options.method).toBe('GET');
    expect(harness.options.path).toBe('/w/api.php?q=test');
    expect(harness.options.headers.Authorization).toBeUndefined();
    expect(() => new HttpsPublicSourceTransport('https://target.test', { userAgent: 'invalid\r\nheader' })).toThrow('invalid_user_agent');
    expect(harness.body).toBeUndefined();
    await expect(t.get('https://other.test/w/api.php')).rejects.toThrow('invalid_endpoint');
    expect(() => targetUrl('https://target.test/?q=test')).toThrow('invalid_endpoint');
    for (const origin of ['http://target.test', 'https://user:pass@target.test', 'https://target.test/path', 'https://target.test/', 'https://target.test?x=y']) {
      expect(() => publicSourceUrl(origin, origin)).toThrow();
    }
  });
});
