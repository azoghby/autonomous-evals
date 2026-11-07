import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestOptions, Server } from 'node:https';
import type { IncomingMessage } from 'node:http';

const wire = vi.hoisted(() => ({ port: 0, ca: undefined as string | undefined,
  options: [] as RequestOptions[] }));
// Real Node HTTPS/TLS. Only the destination and test trust root are substituted,
// because production intentionally forbids loopback addresses and non-443 ports.
vi.mock('node:https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: (options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    wire.options.push(options);
    return actual.request({ ...options, hostname: '127.0.0.1', port: wire.port, ca: wire.ca }, callback);
  } };
});
import { createServer } from 'node:https';
import { HttpsJsonTransport } from './transport.js';

describe('real local TLS sockets with test-only routing and trust root', () => {
  let directory: string, server: Server, certificate: string;
  let received: Array<{ host: string | undefined; sni: string | false | null; body: string }>;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'trackb-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
      '-days', '1', '-subj', '/CN=target.test', '-addext', 'subjectAltName=DNS:target.test'],
    { stdio: 'ignore', timeout: 10_000 });
    certificate = await readFile(join(directory, 'cert.pem'), 'utf8');
    server = createServer({ key: await readFile(join(directory, 'key.pem')), cert: certificate }, (req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        received.push({ host: req.headers.host, sni: (req.socket as import('node:tls').TLSSocket).servername, body });
        if (req.url === '/hang') return;
        if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
        if (req.url === '/encoded') res.setHeader('content-encoding', 'gzip');
        res.end(JSON.stringify({ value: req.url === '/large' ? 'x'.repeat(2000) : 'ok' }));
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    wire.port = (server.address() as import('node:net').AddressInfo).port;
  });
  beforeEach(() => { received = []; wire.options = []; wire.ca = certificate; });
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const client = (maxResponseBytes = 1000, timeoutMs = 2000) => new HttpsJsonTransport({
    resolver: async () => [{ address: '8.8.8.8', family: 4 }], maxResponseBytes, timeoutMs,
  });
  it('sends original Host and SNI while production options address the pinned public IP', async () => {
    expect(await client().post('https://target.test/ok', { fixture: true })).toEqual({ value: 'ok' });
    expect(wire.options[0]).toMatchObject({ hostname: '8.8.8.8', port: 443, servername: 'target.test', rejectUnauthorized: true });
    expect(received).toEqual([{ host: 'target.test', sni: 'target.test', body: '{"fixture":true}' }]);
  });
  it('rejects a trusted certificate for a different original hostname before sending HTTP', async () => {
    await expect(client().post('https://other.test/ok', {})).rejects.toThrow('transport_error');
    expect(received).toHaveLength(0);
  });
  it('rejects an untrusted issuer before sending HTTP', async () => {
    wire.ca = undefined;
    await expect(client().post('https://target.test/ok', {})).rejects.toThrow('transport_error');
    expect(received).toHaveLength(0);
  });
  it('enforces received byte limits on a real response stream', async () => {
    await expect(client(50).post('https://target.test/large', {})).rejects.toThrow('response_too_large');
  });
  it('rejects redirects without issuing another HTTP request', async () => {
    await expect(client().post('https://target.test/redirect', {})).rejects.toThrow('provider_http_error');
    expect(received).toHaveLength(1); expect(wire.options).toHaveLength(1);
  });
  it('rejects compressed responses without decoding', async () => {
    await expect(client().post('https://target.test/encoded', {})).rejects.toThrow('unsupported_encoding');
  });
  it('aborts an open response at the total deadline', async () => {
    await expect(client(1000, 200).post('https://target.test/hang', {})).rejects.toThrow('timeout');
  });
});
