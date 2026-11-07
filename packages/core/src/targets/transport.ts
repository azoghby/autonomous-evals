import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import ipaddr from 'ipaddr.js';

export class TargetError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'TargetError'; }
}
export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const resolve: Resolver = hostname => lookup(hostname, { all: true, verbatim: true });

/** Conservative public unicast only; transition/mapped IPv6 is deliberately refused. */
export function isPublicAddress(address: string): boolean {
  if (!isIP(address) || address.includes('%')) return false;
  const ip = ipaddr.parse(address);
  if (ip.range() !== 'unicast') return false;
  if (ip.kind() === 'ipv6') {
    return ip.match(ipaddr.parse('2000::'), 3) && !ip.match(ipaddr.parse('2001::'), 23)
      && !ip.match(ipaddr.parse('3fff::'), 20) && !ip.match(ipaddr.parse('2002::'), 16);
  }
  return true;
}
export function targetUrl(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new TargetError('invalid_endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.port && url.port !== '443')) {
    throw new TargetError('invalid_endpoint');
  }
  if (!url.hostname || url.hostname.endsWith('.localhost') || url.hostname === 'localhost') throw new TargetError('blocked_address');
  return url;
}
export async function resolvePublic(hostname: string, resolver: Resolver = resolve) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const records = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host);
  if (!records.length || records.some(r => !isPublicAddress(r.address) || isIP(r.address) !== r.family)) {
    throw new TargetError('blocked_address');
  }
  return records[0]!;
}

/** Global per-process limit, shared by every client, with bounded admission. */
export class TargetGate {
  private active = 0;
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= 2) throw new TargetError('target_busy');
    this.active++;
    try { return await fn(); } finally { this.active--; }
  }
}
const globalGate = new TargetGate();
export interface JsonTransport { post(endpoint: string, body: unknown, bearer?: string): Promise<unknown> }
export interface TransportOptions {
  timeoutMs?: number; maxRequestBytes?: number; maxResponseBytes?: number;
  resolver?: Resolver; gate?: TargetGate;
}
export class HttpsJsonTransport implements JsonTransport {
  private readonly timeout: number;
  private readonly requestLimit: number;
  private readonly responseLimit: number;
  constructor(private readonly options: TransportOptions = {}) {
    this.timeout = bounded(options.timeoutMs, 30_000);
    this.requestLimit = bounded(options.maxRequestBytes, 256_000);
    this.responseLimit = bounded(options.maxResponseBytes, 1_000_000);
  }
  post(endpoint: string, body: unknown, bearer?: string): Promise<unknown> {
    return (this.options.gate ?? globalGate).run(async () => {
      const url = targetUrl(endpoint);
      if (bearer !== undefined && (!bearer || bearer.length > 8192 || /[^\x21-\x7e]/.test(bearer))) throw new TargetError('invalid_credential');
      let payload: string;
      try { payload = JSON.stringify(body); } catch { throw new TargetError('invalid_request'); }
      if (!payload! || Buffer.byteLength(payload) > this.requestLimit) throw new TargetError('request_too_large');
      // Deadline includes DNS. No second DNS resolution, agent pooling, redirects, or environment proxy.
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new TargetError('timeout')); }, this.timeout);
      });
      try {
        return await Promise.race([deadline, (async () => {
          const pinned = await resolvePublic(url.hostname, this.options.resolver);
          if (controller.signal.aborted) throw new TargetError('timeout');
          return new Promise<unknown>((resolve, reject) => {
            const host = url.hostname.replace(/^\[|\]$/g, '');
            const req = request({
              protocol: 'https:', hostname: pinned.address, family: pinned.family,
              port: 443, path: url.pathname, method: 'POST', agent: false,
              servername: isIP(host) ? '' : host, rejectUnauthorized: true,
              checkServerIdentity: (_name, cert) => checkServerIdentity(host, cert),
              signal: controller.signal,
              headers: { Host: url.host, 'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload), Accept: 'application/json',
                ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
            }, res => {
              if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
                res.destroy(); reject(new TargetError('provider_http_error')); return;
              }
              if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
                res.destroy(); reject(new TargetError('unsupported_encoding')); return;
              }
              let size = 0; const chunks: Buffer[] = [];
              res.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > this.responseLimit) { res.destroy(); reject(new TargetError('response_too_large')); }
                else chunks.push(chunk);
              });
              res.on('error', () => reject(new TargetError('transport_error')));
              res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch { reject(new TargetError('invalid_json')); }
              });
            });
            req.on('error', () => reject(new TargetError(controller.signal.aborted ? 'timeout' : 'transport_error')));
            req.end(payload);
          });
        })()]);
      } catch (e) { throw e instanceof TargetError ? e : new TargetError('transport_error'); }
      finally { clearTimeout(timer!); }
    });
  }
}
function bounded(value: number | undefined, maximum: number) {
  if (value === undefined) return maximum;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new TargetError('invalid_limit');
  return value;
}
