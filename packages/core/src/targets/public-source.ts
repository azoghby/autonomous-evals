import { request } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { resolvePublic, targetUrl, TargetError, TargetGate, type TransportOptions } from './transport';

export interface PublicSourceTransportOptions extends TransportOptions { userAgent?: string }
export interface PublicSourceTransport { get(endpoint: string): Promise<unknown> }
/** GET-only policy. POST targetUrl deliberately continues to reject all query strings. */
export function publicSourceUrl(endpoint: string, providerOrigin: string): URL {
  const origin = targetUrl(providerOrigin);
  if (origin.pathname !== '/' || origin.origin !== providerOrigin) throw new TargetError('invalid_provider_origin');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new TargetError('invalid_endpoint'); }
  if (url.origin !== origin.origin || url.username || url.password || url.hash) throw new TargetError('invalid_endpoint');
  targetUrl(url.origin + url.pathname);
  return url;
}
const globalGate = new TargetGate();
export class HttpsPublicSourceTransport implements PublicSourceTransport {
  private readonly timeout: number;
  private readonly userAgent: string;
  private readonly requestLimit: number;
  private readonly responseLimit: number;
  constructor(private readonly origin: string, private readonly options: PublicSourceTransportOptions = {}) {
    publicSourceUrl(origin, origin);
    this.userAgent = options.userAgent ?? 'StandardEvals-PublicDiscovery/1.0';
    if (!this.userAgent || this.userAgent.length > 256 || /[^\x20-\x7e]/.test(this.userAgent)) throw new TargetError('invalid_user_agent');
    this.timeout = bounded(options.timeoutMs, 30_000);
    this.requestLimit = bounded(options.maxRequestBytes, 256_000);
    this.responseLimit = bounded(options.maxResponseBytes, 1_000_000);
  }
  get(endpoint: string): Promise<unknown> {
    return (this.options.gate ?? globalGate).run(async () => {
      const url = publicSourceUrl(endpoint, this.origin);
      if (Buffer.byteLength(url.pathname + url.search) > this.requestLimit) throw new TargetError('request_too_large');
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
              port: 443, path: url.pathname + url.search, method: 'GET', agent: false,
              servername: isIP(host) ? '' : host, rejectUnauthorized: true,
              checkServerIdentity: (_name, cert) => checkServerIdentity(host, cert),
              signal: controller.signal,
              headers: { Host: url.host, Accept: 'application/json', 'Accept-Encoding': 'identity',
                'User-Agent': this.userAgent },
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
            req.end();
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
