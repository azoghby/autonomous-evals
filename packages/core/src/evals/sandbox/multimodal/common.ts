import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
export interface DispatchRequest {
  operationId: string; capability: string; url: string; body: BodyInit;
  headers?: Record<string, string>; response: 'json' | 'bytes'; signal?: AbortSignal;
}
export interface DispatchResult { bytes: Uint8Array; contentType: string; elapsedMs: number; responseDigest: string }
export interface MediaTransport { dispatch(request: DispatchRequest): Promise<DispatchResult> }
export interface DurableAuthority {
  /** Atomic, permanent claim. Pending claims MUST refuse redispatch after a crash. */
  claim(key: string, identity: string): Promise<{ state: 'new' | 'pending' } | { state: 'completed'; result: DispatchResult }>;
  complete(key: string, identity: string, result: DispatchResult): Promise<void>;
}
export interface MediaMeter {
  /** Atomic shared job/trial/global reservation; throws if cap or authorization is absent. */
  reserve(input: { operationId: string; identity: string; capability: string; maxMicroUsd: number }): Promise<void>;
  /** Raw evidence only. Missing authoritative provider cost MUST remain unknown, never estimated/zero. */
  observed(input: { operationId: string; identity: string; responseDigest: string; bytes: number; elapsedMs: number }): Promise<void>;
}
export interface TransportOptions {
  fetchImpl?: typeof fetch; authority: DurableAuthority; meter: MediaMeter;
  /** Exact server-approved URLs; fetch must enforce DNS pinning for customer endpoints. */
  allowedUrls: readonly string[]; authorize: (operationId: string, capability: string) => Promise<void>;
  token: () => Promise<string>; secrets: readonly string[];
  maxRequestBytes: number; maxResponseBytes: number; timeoutMs: number; maxMicroUsd: number;
}
function positive(n: number) { return Number.isSafeInteger(n) && n > 0; }
export function assertNoSecrets(value: Uint8Array | string, secrets: readonly string[]): void {
  const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  for (const secret of secrets.filter(Boolean)) {
    for (const form of [secret, Buffer.from(secret).toString('base64'), JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) {
      if (bytes.includes(Buffer.from(form))) throw new Error('media_secret_boundary');
    }
  }
}
/** No default fetch: callers must provide a secured, approved transport. Never logs provider errors. */
export function createMediaTransport(o: TransportOptions): MediaTransport {
  if (![o.maxRequestBytes, o.maxResponseBytes, o.timeoutMs, o.maxMicroUsd].every(positive)) throw new Error('media_bounds_invalid');
  const allowed = new Set(o.allowedUrls);
  for (const url of allowed) { const u = new URL(url); if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error('media_url_invalid'); }
  return { async dispatch(r) {
    if (!o.fetchImpl) throw new Error('unsupported_media_transport');
    if (!r.operationId || !r.capability || !allowed.has(r.url)) throw new Error('media_dispatch_not_authorized');
    // These are the actual SDK JSON payloads. Streaming, multipart and arbitrary binary requests are unsupported.
    if (typeof r.body !== 'string') throw new Error('unsupported_media_request_body');
    const body = r.body;
    if (Buffer.byteLength(body) > o.maxRequestBytes) throw new Error('media_request_bound');
    const headers = new Headers(r.headers);
    headers.delete('authorization'); // Credential injection happens only at the final approved dispatch.
    const secrets = [...o.secrets];
    assertNoSecrets(body, secrets); assertNoSecrets(JSON.stringify([...headers]), secrets);
    const identity = digest(JSON.stringify({ url: r.url, capability: r.capability, body, headers: [...headers].sort(), response: r.response, maxMicroUsd: o.maxMicroUsd }));
    const controller = new AbortController();
    const abort = () => controller.abort();
    r.signal?.addEventListener('abort', abort, { once: true });
    if (r.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, o.timeoutMs);
    const guarded = async (): Promise<DispatchResult> => {
      controller.signal.throwIfAborted();
      await o.authorize(r.operationId, r.capability); // Replay requires current authority too.
      controller.signal.throwIfAborted();
      const claim = await o.authority.claim(r.operationId, identity);
      if (claim.state === 'pending') throw new Error('media_pending_reconciliation');
      if (claim.state === 'completed') {
        const result = claim.result;
        if (result.bytes.length > o.maxResponseBytes || digest(result.bytes) !== result.responseDigest) throw new Error('media_replay_corrupt');
        assertNoSecrets(result.bytes, secrets);
        return { ...result, bytes: result.bytes.slice() };
      }
      await o.meter.reserve({ operationId: r.operationId, identity, capability: r.capability, maxMicroUsd: o.maxMicroUsd });
      controller.signal.throwIfAborted();
      const token = await o.token();
      if (!token || /[\r\n]/.test(token)) throw new Error('media_credential_invalid');
      secrets.push(token);
      assertNoSecrets(body, secrets);
      headers.set('authorization', `Bearer ${token}`);
      controller.signal.throwIfAborted();
      const start = performance.now();
      const response = await o.fetchImpl!(r.url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error('media_transport_http_failure'); }
      const contentType = response.headers.get('content-type') ?? '';
      if (r.response === 'json' && !contentType.includes('application/json')) { await response.body?.cancel(); throw new Error('media_response_type'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('media_empty_response');
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { controller.signal.throwIfAborted(); const next = await reader.read(); if (next.done) break; size += next.value.length;
        if (size > o.maxResponseBytes) throw new Error('media_response_bound'); chunks.push(next.value); } }
      catch { void reader.cancel().catch(() => {}); throw new Error('media_response_incomplete'); }
      const bytes = new Uint8Array(Buffer.concat(chunks));
      if (!bytes.length) throw new Error('media_empty_response');
      assertNoSecrets(bytes, secrets);
      const result = { bytes, contentType, elapsedMs: performance.now() - start, responseDigest: digest(bytes) };
      controller.signal.throwIfAborted();
      await o.meter.observed({ operationId: r.operationId, identity, responseDigest: result.responseDigest, bytes: size, elapsedMs: result.elapsedMs });
      controller.signal.throwIfAborted();
      await o.authority.complete(r.operationId, identity, result);
      return result;
    };
    try {
      return await new Promise<DispatchResult>((resolve, reject) => {
        const cancelled = () => reject(new Error('media_aborted_or_deadline'));
        controller.signal.addEventListener('abort', cancelled, { once: true });
        if (controller.signal.aborted) cancelled();
        else void guarded().then(resolve, () => reject(new Error('media_dispatch_failed_or_pending')));
      });
    } finally { clearTimeout(timer); r.signal?.removeEventListener('abort', abort); }
  } };
}
/** SDK and A ChatAudioVoiceDriver both use this real Fetch-compatible boundary. */
export function createSecuredFetch(transport: MediaTransport, operationPrefix: string, capability: string): typeof fetch {
  let sequence = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request || !init?.body || (init.method ?? 'GET').toUpperCase() !== 'POST') throw new Error('unsupported_media_fetch');
    const headers = Object.fromEntries(new Headers(init.headers));
    const result = await transport.dispatch({ operationId: `${operationPrefix}:${sequence++}`, capability, url: String(input), body: init.body,
      headers, response: 'json', signal: init.signal ?? undefined });
    return new Response(result.bytes.slice() as BodyInit, { status: 200, headers: { 'content-type': result.contentType } });
  }) as typeof fetch;
}
/** Private on-disk journal for a single host. Production distributed workers need SQL authority.
 * Permanent directory claim, synced result and atomic rename fence ambiguous dispatch across restart.
 */
export class FileMediaAuthority implements DurableAuthority {
  constructor(private readonly root: string) {}
  private path(key: string) { return join(this.root, digest(key)); }
  async claim(key: string, identity: string): ReturnType<DurableAuthority['claim']> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const dir = this.path(key);
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let existing: string;
      try { existing = await readFile(join(dir, 'identity'), 'utf8'); } catch { return { state: 'pending' }; }
      if (existing !== identity) throw new Error('media_identity_conflict');
      try {
        const value = JSON.parse(await readFile(join(dir, 'result'), 'utf8')) as DispatchResult & { bytes: string };
        const bytes = new Uint8Array(Buffer.from(value.bytes, 'base64'));
        if (digest(bytes) !== value.responseDigest) throw new Error('media_replay_corrupt');
        return { state: 'completed', result: { ...value, bytes } };
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'pending' }; throw error; }
    }
    await this.syncWrite(join(dir, 'identity'), identity);
    await this.syncDir(dir); await this.syncDir(this.root);
    return { state: 'new' };
  }
  private async syncWrite(path: string, value: string) {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
  }
  private async syncDir(path: string) { const dir = await open(path, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  async complete(key: string, identity: string, result: DispatchResult): Promise<void> {
    const dir = this.path(key);
    if (await readFile(join(dir, 'identity'), 'utf8') !== identity) throw new Error('media_identity_conflict');
    await this.syncWrite(join(dir, 'result.tmp'), JSON.stringify({ ...result, bytes: Buffer.from(result.bytes).toString('base64') }));
    await rename(join(dir, 'result.tmp'), join(dir, 'result')); await this.syncDir(dir);
  }
}
