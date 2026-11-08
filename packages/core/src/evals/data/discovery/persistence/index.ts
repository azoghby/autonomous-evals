import { createHash } from 'node:crypto';
import type { AgentTransactionalSql } from '../../../../agents/postgres-ports';
import { PostgresTextCheckpointStore, type CheckpointKey, type TextCheckpointStore } from '../../../integration/checkpoints';
import { inspectDataSafety } from '../../quality';
import type { DiscoveryOperations } from '../index';
import { validateDiscoveryBatch, type DiscoveryStoredResult } from './validation';

/** Resolve from authenticated server context and an authorized job lookup, never request.task. */
export interface AuthenticatedDiscoveryScope { tenantId: string; jobId: string }
export interface DiscoveryPersistenceOptions {
  store: TextCheckpointStore;
  authenticatedScope: AuthenticatedDiscoveryScope;
  knownSecrets?: readonly string[];
}
const fail = (code: string): never => { throw new Error(`discovery_persistence_${code}`); };
const hash = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const kind = 'public-discovery-v1';
const safeErrors = new Map([
  ['text_checkpoint_identity_conflict', 'input_conflict'],
  ['text_checkpoint_not_owner', 'not_owner'],
  ['text_checkpoint_ambiguous', 'ambiguous'],
  ['text_checkpoint_completion_conflict', 'completion_conflict'],
]);
async function storage<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    // No SQL, parameters, provider payload, original cause or connection strings escape.
    return fail(error instanceof Error ? safeErrors.get(error.message) ?? 'storage_unavailable' : 'storage_unavailable');
  }
}

/** Job-lifetime adapter. Claims never expire, release, or transfer ownership. */
export function createDiscoveryOperations(options: DiscoveryPersistenceOptions): DiscoveryOperations {
  const secrets = [...(options.knownSecrets ?? [])];
  const identity = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 1024
      || /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value)
      || !inspectDataSafety(value, secrets).safe) return fail('invalid_identity');
    return value;
  };
  const tenant = identity(options.authenticatedScope.tenantId);
  const job = identity(options.authenticatedScope.jobId);
  // JSON tuple framing prevents delimiter collisions; separate domains prevent cross-purpose reuse.
  const jobId = `discovery:v1:${hash(['discovery-scope-v1', tenant, job])}`;
  const store = options.store;
  const owners = new Map<string, { digest: string; token: string }>();
  const checkpoint = (key: string, digest: string): CheckpointKey => {
    identity(key);
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return fail('invalid_identity');
    return { jobId, kind, id: hash(['discovery-operation-v1', key]), inputDigest: digest };
  };
  const validate = (value: unknown): DiscoveryStoredResult => {
    try { return validateDiscoveryBatch(value, secrets); } catch { return fail('invalid_result'); }
  };
  return {
    async claim(key, digest) {
      const record = checkpoint(key, digest);
      const result = await storage(() => store.claim(record));
      if (result.state === 'claimed') {
        const previous = owners.get(record.id);
        // A late pending response MUST NOT delete/replace the concurrent winning token.
        if (previous && (previous.digest !== digest || previous.token !== result.token)) return fail('not_owner');
        owners.set(record.id, { digest, token: result.token });
        return { state: 'claimed' };
      }
      if (result.state === 'completed') {
        const value = validate(result.value);
        return 'status' in value ? { state: 'rejected', rejection: value.rejection } : { state: 'complete', data: value };
      }
      return { state: 'pending' }; // Includes ambiguous: never dispatch again automatically.
    },
    async complete(key, digest, data) {
      const batch = validate(data);
      if ('status' in batch) return fail('invalid_result');
      await finish(key, digest, batch);
    },
    async reject(key, digest, rejection) {
      await finish(key, digest, validate({ status: 'rejected', rejection }));
    },
  };
  async function finish(key: string, digest: string, value: DiscoveryStoredResult): Promise<void> {
    const record = checkpoint(key, digest);
    const owner = owners.get(record.id);
    if (!owner) return fail('not_owner');
    if (owner.digest !== digest) return fail('input_conflict');
    await storage(() => store.complete(record, owner.token, value));
    // Keep ownership for identical retries after lost completion acknowledgements.
  }
}

/** Existing text_integration migration must already be applied by the application. */
export function createPostgresDiscoveryOperations(options: Omit<DiscoveryPersistenceOptions, 'store'> & {
  db: AgentTransactionalSql;
}): DiscoveryOperations {
  return createDiscoveryOperations({ ...options, store: new PostgresTextCheckpointStore(options.db) });
}
