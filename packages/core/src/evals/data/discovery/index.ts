import { createHash } from 'node:crypto';
import type { AcquisitionRequest, AcquisitionResult, DataBatch, DiscoveryRejection, DiscoveryRejectionReason, EvaluationDataPorts } from '../acquisition';
import { reviewDigest } from '../binding';
import { inspectDataSafety } from '../quality';
import type { DataSource } from '../types';
import { validateDiscoveryBatch } from './persistence/validation';
import { validateDiscoveryRejection } from './rejection';
import { HttpsPublicSourceTransport, publicSourceUrl, type PublicSourceTransport } from '../../../targets/public-source';

/** Application-supplied durable atomic ledger. Never expire/reclaim an ambiguous claim automatically. */
export interface DiscoveryOperations {
  /** Atomically bind key to digest before granting exactly one caller claimed. Reject digest conflicts. */
  claim(key: string, digest: string): Promise<
    { state: 'claimed' } | { state: 'pending' } | { state: 'complete'; data: DataBatch } | { state: 'rejected'; rejection: DiscoveryRejection }
  >;
  /** Atomically persist result under the existing digest; failure leaves the claim pending. */
  complete(key: string, digest: string, data: DataBatch): Promise<void>;
  /** Optional for legacy stores: absence fails closed, never pretends rejection was durable. */
  reject?(key: string, digest: string, rejection: DiscoveryRejection): Promise<void>;
}
export interface MediaWikiDiscoveryConfig {
  providerOrigin: string;
  /** Trusted operator-selected search terms, never instructions from source content. */
  queries: readonly string[];
  /** Public application identity/contact URL only, never credentials or private contact details. */
  userAgent?: string;
  operations: DiscoveryOperations;
  transport?: PublicSourceTransport;
  maxResults?: number;
  maxContentChars?: number;
  knownSecrets?: readonly string[];
  now?: () => Date;
}
const digestContent = (text: string) => createHash('sha256').update(text).digest('hex');
class DefinitiveRejection extends Error {
  constructor(readonly reasons: DiscoveryRejectionReason[]) { super('public_discovery_invalid_response'); }
}
function fail(reason: DiscoveryRejectionReason = 'invalid_response'): never { throw new DefinitiveRejection([reason]); }
function screen(value: unknown, secrets: readonly string[]): void {
  const safety = inspectDataSafety(value, secrets);
  if (!safety.safe) throw new DefinitiveRejection(safety.reasons.map(code =>
    code === 'pii_detected' || code === 'secret_detected' ? code : code === 'data_too_large' ? 'content_limit_exceeded' : 'unsafe_data'));
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const positive = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fail();
const limit = (value: number | undefined, maximum: number): number => value === undefined ? maximum : Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : (() => { throw new Error('public_discovery_invalid_config'); })();

/** Concrete no-secret MediaWiki Action API discover port; candidate sources only. */
export function createMediaWikiDiscovery(config: MediaWikiDiscoveryConfig): Pick<EvaluationDataPorts, 'discover'> {
  const origin = publicSourceUrl(config.providerOrigin, config.providerOrigin).origin;
  const queries = [...config.queries];
  const operations = config.operations;
  const now = config.now;
  const userAgent = config.userAgent ?? 'StandardEvals-PublicDiscovery/1.0';
  if (!userAgent || userAgent.length > 256 || /[^\x20-\x7e]/.test(userAgent)) throw new Error('public_discovery_invalid_config');
  const maxResults = limit(config.maxResults, 5);
  const maxContentChars = limit(config.maxContentChars, 80_000);
  const knownSecrets = [...(config.knownSecrets ?? [])];
  if (!operations || typeof operations.claim !== 'function' || typeof operations.complete !== 'function'
    || !queries.length || queries.length > 3 || queries.some(q => typeof q !== 'string' || !q.trim() || q.length > 256)
    || !inspectDataSafety({ origin, queries, userAgent }, knownSecrets).safe) throw new Error('public_discovery_invalid_config');
  const transport = config.transport ?? new HttpsPublicSourceTransport(origin, { maxRequestBytes: 4096, maxResponseBytes: 256_000, userAgent });
  const identity = { version: 'mediawiki-discovery-v1', origin, queries, userAgent, maxResults, maxContentChars };
  const api = (params: Record<string, string>): string => {
    const url = new URL('/w/api.php', origin);
    url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params }).toString();
    return url.href;
  };
  const read = async (url: string): Promise<Record<string, unknown>> => {
    let raw: unknown;
    try { raw = await transport.get(url); } catch { throw new Error('public_discovery_provider_unavailable'); }
    // Also enforce bounds with injected ports, before admitting provider-controlled data.
    const text = JSON.stringify(raw);
    if (!text) fail();
    if (Buffer.byteLength(text) > 256_000) fail('content_limit_exceeded');
    const response = object(raw);
    if (response.error || response.errors || response.warnings) throw new Error('public_discovery_provider_unavailable');
    if (response.redirects) fail();
    return object(response.query);
  };
  const validateBatch = (batch: DataBatch): DataBatch => {
    screen(batch, knownSecrets);
    if (!Array.isArray(batch.sources) || !Array.isArray(batch.cases)
      || batch.cases.length || batch.sources.length > maxResults) fail();
    let chars = 0;
    const ids = new Set<string>();
    for (const source of batch.sources) {
      chars += source.content.length;
      if (ids.has(source.id) || source.provenance.origin !== 'public' || source.provenance.producerId !== `mediawiki:${origin}`
        || source.provenance.contentHash !== digestContent(source.content) || !Number.isFinite(Date.parse(source.provenance.retrievedAt))
        || source.review.status !== 'pending' || source.license.permission !== 'unknown' || source.license.allowedUses.length
        || !source.url.startsWith(`${origin}/w/index.php?oldid=`) || !/^\d+$/.test(source.url.split('oldid=')[1] ?? '')) fail();
      ids.add(source.id);
    }
    if (chars > maxContentChars) fail('content_limit_exceeded');
    try { validateDiscoveryBatch(batch, knownSecrets); } catch { fail(); }
    return structuredClone(batch);
  };
  return { discover: async (input: AcquisitionRequest): Promise<AcquisitionResult> => {
    const request = structuredClone(input);
    if (!request.operationKey || request.operationKey.length > 1024 || !inspectDataSafety(request, knownSecrets).safe) throw new Error('public_discovery_unsafe_request');
    const digest = reviewDigest({ identity, request });
    const operation = await operations.claim(request.operationKey, digest);
    if (operation.state === 'pending') return { status: 'pending' };
    if (operation.state === 'rejected') return { status: 'rejected', rejection: validateDiscoveryRejection(operation.rejection) };
    if (operation.state === 'complete') return { status: 'complete', data: validateBatch(operation.data) };
    let data: DataBatch;
    try {
      const pageIds = new Set<number>();
      // Hard upper bound: <=3 searches + one batched revision retrieval. Ignore continuation.
      for (const query of queries) {
        if (pageIds.size >= maxResults) break;
        const response = await read(api({ list: 'search', srsearch: query, srnamespace: '0', srprop: '', srlimit: String(maxResults - pageIds.size) }));
        if (!Array.isArray(response.search) || response.search.length > maxResults - pageIds.size) fail();
        for (const hit of response.search) pageIds.add(positive(object(hit).pageid));
      }
      const sources: DataSource[] = [];
      if (pageIds.size) {
        const response = await read(api({ prop: 'revisions', pageids: [...pageIds].join('|'), rvprop: 'ids|content|contentmodel', rvslots: 'main' }));
        if (!Array.isArray(response.pages) || response.pages.length !== pageIds.size) fail();
        const seen = new Set<number>();
        for (const value of response.pages) {
          const page = object(value); const pageId = positive(page.pageid);
          if (!pageIds.has(pageId) || seen.has(pageId) || page.missing || page.invalid) fail();
          seen.add(pageId);
          if (!Array.isArray(page.revisions) || page.revisions.length !== 1) fail();
          const revision = object(page.revisions[0]); const revisionId = positive(revision.revid);
          const slot = object(object(revision.slots).main);
          if (typeof slot.content !== 'string' || !slot.content.trim() || slot.contentmodel !== 'wikitext') fail();
          sources.push({
            id: `mw_${reviewDigest({ origin, pageId, revisionId }).slice(0, 48)}`,
            url: `${origin}/w/index.php?oldid=${revisionId}`, content: slot.content,
            license: { name: 'Unknown', url: origin, permission: 'unknown', allowedUses: [] },
            provenance: { origin: 'public', producerId: `mediawiki:${origin}`, retrievedAt: (now?.() ?? new Date()).toISOString(), contentHash: digestContent(slot.content) },
            review: { status: 'pending', reviewerId: '', reviewedAt: '', notes: 'Untrusted public retrieval; permission and independent review required.' },
          });
        }
      }
      data = validateBatch({ sources, cases: [] });
    } catch (error) {
      if (!(error instanceof DefinitiveRejection)) throw error;
      const rejection = validateDiscoveryRejection({ reasons: error.reasons });
      if (!operations.reject) throw new Error('public_discovery_rejection_storage_unavailable');
      // Persistence is outside the retrieval catch: uncertain writes never become terminal results.
      await operations.reject(request.operationKey, digest, structuredClone(rejection));
      return { status: 'rejected', rejection };
    }
    await operations.complete(request.operationKey, digest, structuredClone(data));
    return { status: 'complete', data };
  } };
}
