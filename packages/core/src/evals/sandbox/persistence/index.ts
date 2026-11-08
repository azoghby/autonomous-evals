import type { AgentTransactionalSql } from '../../../agents/postgres-ports';
import { containsSecret } from '../../../agents/redact';
import { PostgresTextCheckpointStore, type CheckpointKey } from '../../integration/checkpoints';
import { executionDigest } from '../execution/runner';
import type { GateReplayPort } from '../generation/gates';
import type { PrivateSandboxReport } from '../integration';
import { validatePrivateReport } from './schema';

export interface SandboxPersistenceScope { tenantId: string; jobId: string; environmentId: string }
export type SandboxPersistenceOperation = 'replay' | 'report_read' | 'report_write' | 'generation_bind';
export interface PostgresSandboxPersistenceConfig {
  db: AgentTransactionalSql;
  /** Trusted server binding, never taken from model input. */
  scope: SandboxPersistenceScope;
  /** Resolve current authenticated principal, ownership and job/environment binding on EVERY call. */
  authorize(input: { scope: SandboxPersistenceScope; operation: SandboxPersistenceOperation }): Promise<boolean>;
  /** Include revoked credentials when constructing a new process to retain historic coverage. */
  knownSecrets?: readonly string[] | (() => readonly string[]);
  maxPayloadBytes?: number;
}
type Envelope = {
  schema: 'sandbox-persistence-v1'; scope: SandboxPersistenceScope; kind: string;
  keyDigest: string; inputDigest: string; payloadDigest: string; payload: unknown;
};
const invalid = (): never => { throw new Error('sandbox_persistence_invalid_payload'); };
const identity = (value: string) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000\uD800-\uDFFF]/u.test(value)) invalid();
};

/** Exact JSON only: no coercion, toJSON hooks, accessors, sparse arrays or silently omitted data. */
function json(value: unknown, maxBytes: number): string {
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 80) invalid();
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'string') { if (/[\u0000\uD800-\uDFFF]/u.test(v)) invalid(); return; }
    if (typeof v === 'number') { if (!Number.isFinite(v) || Object.is(v, -0)) invalid(); return; }
    if (typeof v !== 'object' || seen.has(v)) invalid();
    const obj = v as object;
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) invalid();
    seen.add(obj);
    const keys = Reflect.ownKeys(obj);
    if (keys.some(k => typeof k !== 'string')) invalid();
    if (Array.isArray(v) && (keys.length !== v.length + 1 || !Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean))) invalid();
    for (const k of keys as string[]) {
      if (Array.isArray(v) && k === 'length') continue;
      if (/[\u0000\uD800-\uDFFF]/u.test(k)) invalid();
      const d = Object.getOwnPropertyDescriptor(obj, k)!;
      if (!d.enumerable || !Object.hasOwn(d, 'value')) invalid();
      walk(d.value, depth + 1);
    }
    seen.delete(obj);
  };
  walk(value, 0);
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > maxBytes) invalid();
  return encoded;
}

export function privateSandboxReportDigest(report: PrivateSandboxReport): string {
  json(report, 16_000_000);
  return executionDigest(report);
}

/** Reuses text_integration.checkpoints (001-text-integration.sql), with no new DDL.
 * These fixed namespaces are private to this adapter. Do not expose the raw store or
 * release rows: pending/ambiguous operations are permanently fenced for reconciliation.
 * The supplied transaction port must commit before resolving; no callback retries. */
export function createPostgresSandboxPersistence(config: PostgresSandboxPersistenceConfig) {
  const scope = { ...config.scope };
  for (const v of [scope.tenantId, scope.jobId, scope.environmentId]) identity(v);
  const maxBytes = config.maxPayloadBytes ?? 4_000_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_000_000 || typeof config.authorize !== 'function') invalid();
  const authorize = config.authorize;
  const source = config.knownSecrets;
  const retained = new Set<string>();
  const secrets = () => {
    const values = typeof source === 'function' ? source() : source ?? [];
    if (!Array.isArray(values) || values.some(v => typeof v !== 'string' || !v.length)) throw new Error('sandbox_persistence_invalid_secrets');
    values.forEach(v => retained.add(v));
    return [...retained];
  };
  secrets();
  const screen = <T>(value: T): T => {
    const encoded = json(value, maxBytes);
    const current = secrets();
    if (containsSecret(encoded, current) || current.some(s => encoded.includes(s) || encoded.includes(JSON.stringify(s).slice(1, -1))))
      throw new Error('sandbox_persistence_secret_detected');
    return JSON.parse(encoded) as T;
  };
  const auth = async (operation: SandboxPersistenceOperation) => {
    secrets();
    if (await authorize({ scope: { ...scope }, operation }) !== true) throw new Error('sandbox_persistence_unauthorized');
    secrets();
  };
  const guarded = async <T>(action: SandboxPersistenceOperation, fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); }
    finally { await auth(action); }
  };
  const store = new PostgresTextCheckpointStore(config.db);
  const jobId = `sandbox-persistence-v1:${executionDigest(scope)}`;
  const keyFor = (kind: string, id: string, inputDigest: string): CheckpointKey => {
    identity(id); identity(inputDigest); screen({ id, inputDigest });
    return { jobId, kind, id: executionDigest(id), inputDigest };
  };
  const pack = (kind: string, key: CheckpointKey, payload: unknown): Envelope => screen({
    schema: 'sandbox-persistence-v1', scope, kind, keyDigest: key.id, inputDigest: key.inputDigest,
    payloadDigest: executionDigest(screen(payload)), payload,
  });
  const unpack = (value: unknown, kind: string, key: Pick<CheckpointKey, 'id'> & { inputDigest?: string }): unknown => {
    const e = screen(value) as Envelope;
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).sort().join(',') !== 'inputDigest,keyDigest,kind,payload,payloadDigest,schema,scope'
      || e.schema !== 'sandbox-persistence-v1' || executionDigest(e.scope) !== executionDigest(scope)
      || e.kind !== kind || e.keyDigest !== key.id || typeof e.inputDigest !== 'string'
      || (key.inputDigest !== undefined && e.inputDigest !== key.inputDigest)
      || e.payloadDigest !== executionDigest(e.payload)) throw new Error('sandbox_persistence_envelope_conflict');
    return e.payload;
  };
  const once = async <T>(kind: string, id: string, inputDigest: string, operation: () => Promise<T>, action: SandboxPersistenceOperation): Promise<T> => {
    await auth(action);
    const key = keyFor(kind, id, inputDigest);
    const claim = await guarded(action, () => store.claim(key));
    if (claim.state === 'completed') return screen(unpack(claim.value, kind, key)) as T;
    if (claim.state !== 'claimed') throw new Error('sandbox_persistence_pending_reconciliation');
    // The permanent claim is committed BEFORE this callback. Any failure keeps it pending.
    const payload = screen(await operation());
    await auth(action);
    const envelope = pack(kind, key, payload);
    await store.complete(key, claim.token, envelope);
    await auth(action);
    return screen(payload);
  };
  const replay: GateReplayPort = { once: (key, digest, operation) => once('sandbox_once_v1', key, digest, operation, 'replay') };
  return {
    replay,
    async persistPrivateReport(raw: PrivateSandboxReport): Promise<void> {
      await auth('report_write');
      const report = validatePrivateReport(screen(raw), scope.jobId);
      if (report.execution.input.environment.id !== scope.environmentId) throw new Error('sandbox_persistence_report_scope_conflict');
      const digest = privateSandboxReportDigest(report);
      const key = keyFor('sandbox_private_report_v1', report.execution.input.trialId, digest);
      // No external effects here: atomic claim + completion in ONE short transaction
      // lets concurrent identical immutable upserts both succeed without takeover.
      await config.db.transaction(async tx => {
        const atomic = new PostgresTextCheckpointStore({ query: (sql, params) => tx.query(sql, params), transaction: fn => fn(tx) });
        await auth('report_write');
        const claim = await guarded('report_write', () => atomic.claim(key));
        if (claim.state === 'completed') {
          const saved = validatePrivateReport(unpack(claim.value, key.kind, key), scope.jobId);
          if (privateSandboxReportDigest(saved) !== digest) throw new Error('sandbox_persistence_report_conflict');
          return;
        }
        if (claim.state !== 'claimed') throw new Error('sandbox_persistence_pending_reconciliation');
        await atomic.complete(key, claim.token, pack(key.kind, key, report));
        await auth('report_write');
        screen(report);
      });
      await auth('report_write');
    },
    async readPrivateReport(trialId: string, expectedIdentityDigest?: string): Promise<PrivateSandboxReport | null> {
      await auth('report_read');
      if (expectedIdentityDigest !== undefined && !/^[a-f0-9]{64}$/.test(expectedIdentityDigest)) invalid();
      const lookup = keyFor('sandbox_private_report_v1', trialId, 'lookup');
      const value = await store.get({ jobId: lookup.jobId, kind: lookup.kind, id: lookup.id });
      await auth('report_read');
      if (value === null) return null;
      if (value.state !== 'completed') throw new Error('sandbox_persistence_pending_reconciliation');
      const envelope = screen(value.value) as Envelope;
      const report = validatePrivateReport(unpack(envelope, lookup.kind, { id: lookup.id }), scope.jobId);
      if (report.execution.input.trialId !== trialId || report.execution.input.environment.id !== scope.environmentId || privateSandboxReportDigest(report) !== envelope.inputDigest
        || (expectedIdentityDigest !== undefined && report.execution.identityDigest !== expectedIdentityDigest)) throw new Error('sandbox_persistence_report_identity_conflict');
      return screen(report);
    },
    /** Conservative contract: only the first durable claim returns bound. A generation
     * callback has no completion port, so repeats remain unresolved even with the same
     * digest. Resume requires explicit operator reconciliation, never new work. */
    async bindOperation(operationKey: string, requestDigest: string): Promise<'bound' | 'conflict' | 'unresolved'> {
      await auth('generation_bind');
      const key = keyFor('sandbox_generation_binding_v1', operationKey, requestDigest);
      try {
        const claim = await guarded('generation_bind', () => store.claim(key));
        return claim.state === 'claimed' ? 'bound' : 'unresolved';
      } catch (error) {
        if (error instanceof Error && error.message === 'text_checkpoint_identity_conflict') return 'conflict';
        throw error;
      }
    },
  };
}

/** Engine composition is deliberately separate from the raw, exact-JSON store. */
export { createDurableSandboxEngine } from './engine';
export type { DurableSandboxEngineConfig } from './engine';
