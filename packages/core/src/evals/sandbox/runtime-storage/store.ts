import { createHash } from 'node:crypto';
import type { StateDiff, ToolCallRecord } from '../../../sandbox/spec.js';
import { runtimeBridgeDigest, type PolicyRequest, type ExactRowPolicy } from '../runtime-bridge/index.js';

export interface SnapshotScope { tenantId: string; jobId: string; environmentId: string }
export type SnapshotBinding = PolicyRequest;
export interface StoredSnapshot {
  binding: PolicyRequest;
  policy: ExactRowPolicy | null;
  diff: StateDiff[];
  toolCalls: ToolCallRecord[];
  outbox: Record<string, unknown>[];
  imageDigest: string;
  imageSize: number;
  snapshotId: string;
}
export interface RuntimeStorage {
  put(record: StoredSnapshot, bytes: Uint8Array): Promise<void>;
  get(binding: SnapshotBinding): Promise<{ record: StoredSnapshot; bytes: Uint8Array } | null>;
  retain(binding: SnapshotBinding, until: number): Promise<void>;
  releaseRetention(binding: SnapshotBinding): Promise<void>;
  reap(now: number): Promise<number>;
  /** Recheck ownership before every recovered SQL operation. */
  authorize(operation: 'read' | 'write'): Promise<void>;
  /** Trusted binary-image policy, using the current secret registry. */
  screenImage(bytes: Uint8Array): Promise<void>;
  screenMetadata(value: unknown): void;
}
export function storageInvalid(): never { throw new Error('runtime_storage_invalid'); }
export function storageIdentity(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !v.trim() || v.length > 4096 || /[\u0000\uD800-\uDFFF]/u.test(v)) storageInvalid();
}
/** Reject lossy JSON, getters, coercion hooks, sparse arrays, cycles and oversized metadata. */
export function storageJson(value: unknown, maxBytes = 4_000_000): string {
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 64) storageInvalid();
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'string') { if (/[\u0000\uD800-\uDFFF]/u.test(v)) storageInvalid(); return; }
    if (typeof v === 'number') { if (!Number.isFinite(v) || Object.is(v, -0)) storageInvalid(); return; }
    if (!v || typeof v !== 'object' || seen.has(v)) storageInvalid();
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) storageInvalid();
    seen.add(v);
    const keys = Reflect.ownKeys(v);
    if (keys.some(k => typeof k !== 'string')) storageInvalid();
    if (Array.isArray(v) && (keys.length !== v.length + 1 || !Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean))) storageInvalid();
    for (const k of keys as string[]) {
      if (Array.isArray(v) && k === 'length') continue;
      if (/[\u0000\uD800-\uDFFF]/u.test(k)) storageInvalid();
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if (!d.enumerable || !Object.hasOwn(d, 'value')) storageInvalid();
      walk(d.value, depth + 1);
    }
    seen.delete(v);
  };
  walk(value, 0);
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > maxBytes) storageInvalid();
  return encoded;
}
export function validateBinding(value: SnapshotBinding): SnapshotBinding {
  const b = JSON.parse(storageJson(value)) as SnapshotBinding;
  if (!b || Object.keys(b).sort().join(',') !== 'envHash,executionIdentity,runId,scenarioHash,suiteHash,versions,worldId') storageInvalid();
  for (const key of ['runId', 'worldId', 'executionIdentity', 'scenarioHash', 'envHash', 'suiteHash'] as const) storageIdentity(b[key]);
  if (!b.versions || Object.keys(b.versions).sort().join(',') !== 'envHash,judgeModel,runtime,simulatorModel,spec,suiteHash') storageInvalid();
  Object.values(b.versions).forEach(storageIdentity);
  if (b.envHash !== b.versions.envHash || b.suiteHash !== b.versions.suiteHash) storageInvalid();
  return b;
}
export function imageDigest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function validateStoredSnapshot(value: StoredSnapshot, maxBytes = 4_000_000): StoredSnapshot {
  const r = JSON.parse(storageJson(value, maxBytes)) as StoredSnapshot;
  if (!r || Object.keys(r).sort().join(',') !== 'binding,diff,imageDigest,imageSize,outbox,policy,snapshotId,toolCalls') storageInvalid();
  validateBinding(r.binding);
  if (!Array.isArray(r.diff) || !Array.isArray(r.toolCalls) || !Array.isArray(r.outbox) || !/^[a-f0-9]{64}$/.test(r.imageDigest)
    || !Number.isSafeInteger(r.imageSize) || r.imageSize < 1) storageInvalid();
  if (r.policy !== null) {
    if (!r.policy || typeof r.policy !== 'object') storageInvalid();
    const { policyId, allowed, ...binding } = r.policy;
    storageIdentity(policyId);
    if (!Array.isArray(allowed) || runtimeBridgeDigest(binding) !== runtimeBridgeDigest(r.binding)) throw new Error('runtime_storage_policy_conflict');
  }
  const expected = runtimeBridgeDigest({ request: r.binding, image: r.imageDigest, diff: r.diff, calls: r.toolCalls, outbox: r.outbox });
  if (r.snapshotId !== expected) throw new Error('runtime_storage_snapshot_conflict');
  return r;
}
