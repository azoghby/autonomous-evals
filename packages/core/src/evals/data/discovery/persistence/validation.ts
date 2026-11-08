import { createHash } from 'node:crypto';
import type { DataBatch, DiscoveryRejection } from '../../acquisition';
import { inspectDataSafety } from '../../quality';
import { publicSourceUrl } from '../../../../targets/public-source';

import { validateDiscoveryRejection } from '../rejection';

export type DiscoveryStoredResult = DataBatch | { status: 'rejected'; rejection: DiscoveryRejection };
const invalid = (): never => { throw new Error('discovery_persistence_invalid_result'); };
type ObjectValue = Record<string, unknown>;
function object(value: unknown, keys: string[]): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) return invalid();
  return value as ObjectValue;
}
const text = (value: unknown, nonempty = true): string => {
  if (typeof value !== 'string' || (nonempty && !value.trim())) return invalid();
  return value;
};
function publicUrl(value: unknown): string {
  const url = new URL(text(value));
  publicSourceUrl(url.href, url.origin);
  return url.href;
}

/** Current discovery contract: bounded public candidate sources, no cases or approvals.
 * Reject unknown fields and lossy JSON rather than silently normalizing persisted evidence. */
export function validateDiscoveryBatch(value: unknown, secrets: readonly string[]): DiscoveryStoredResult {
  let nodes = 0;
  const seen = new Set<object>();
  function json(item: unknown, depth: number): void {
    if (++nodes > 10_000 || depth > 12) invalid();
    if (typeof item === 'string') {
      if (/[\u0000\uD800-\uDFFF]/u.test(item)) invalid();
    } else if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(); }
    else if (item !== null && typeof item !== 'boolean') {
      if (typeof item !== 'object') invalid();
      const obj = item as object;
      if (seen.has(obj) || (!Array.isArray(obj) && Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null)) invalid();
      seen.add(obj);
      const properties = Reflect.ownKeys(obj);
      if (Array.isArray(obj) && properties.length !== obj.length + 1) invalid();
      for (const key of properties) {
        if (Array.isArray(obj) && key === 'length') continue;
        if (typeof key !== 'string' || /[\u0000\uD800-\uDFFF]/u.test(key)) invalid();
        const descriptor = Object.getOwnPropertyDescriptor(obj, key)!;
        if (!descriptor.enumerable || !('value' in descriptor)) invalid();
        json(descriptor.value, depth + 1);
      }
      seen.delete(obj);
    }
  }
  json(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 500_000 || !inspectDataSafety(value, secrets).safe) invalid();
  // Snapshot synchronously before any await or SQL serialization.
  const snapshot = JSON.parse(encoded) as Record<string, unknown>;
  if (snapshot && snapshot.status === 'rejected') {
    const result = object(snapshot, ['status', 'rejection']);
    return { status: 'rejected', rejection: validateDiscoveryRejection(result.rejection) };
  }
  const batch = object(snapshot, ['sources', 'cases']);
  if (!Array.isArray(batch.sources) || batch.sources.length > 5 || !Array.isArray(batch.cases) || batch.cases.length) invalid();
  const ids = new Set<string>();
  let chars = 0;
  for (const item of batch.sources as unknown[]) {
    const source = object(item, ['id', 'url', 'content', 'license', 'provenance', 'review']);
    const id = text(source.id);
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(id) || ids.has(id)) invalid();
    ids.add(id);
    publicUrl(source.url);
    chars += text(source.content).length;
    const license = object(source.license, ['name', 'url', 'permission', 'allowedUses']);
    text(license.name); publicUrl(license.url);
    if (license.permission !== 'unknown' || !Array.isArray(license.allowedUses) || license.allowedUses.length) invalid();
    const provenance = object(source.provenance, ['origin', 'producerId', 'retrievedAt', 'contentHash']);
    text(provenance.producerId);
    if (provenance.origin !== 'public' || !Number.isFinite(Date.parse(text(provenance.retrievedAt)))
      || provenance.contentHash !== createHash('sha256').update(source.content as string).digest('hex')) invalid();
    const review = object(source.review, ['status', 'reviewerId', 'reviewedAt', 'notes']);
    text(review.notes, false);
    if (review.status !== 'pending' || review.reviewerId !== '' || review.reviewedAt !== '') invalid();
  }
  if (chars > 80_000) invalid();
  return batch as unknown as DataBatch;
}
