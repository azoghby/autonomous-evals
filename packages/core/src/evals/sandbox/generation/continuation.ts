import { AgentSessionService, outputJsonSchema, taskKeyFor, type AgentTaskOutcome, type AgentTaskSpec } from '../../../agents/session-service';
import type { AgentTransactionalSql } from '../../../agents/postgres-ports';
import { containsSecret } from '../../../agents/redact';
import { PostgresTextCheckpointStore, type CheckpointKey } from '../../integration/checkpoints';
import type { ScenarioGateEvidence } from './gates';
import { executionDigest } from '../execution/runner';
import { createSandboxGenerationAdapter, type SandboxGenerationConfig, type SandboxGenerationRequest, type SandboxGenerationResult, type CandidateAssessment, type GeneratedSandboxCandidate } from './adapter';

export type GenerationAssessmentReceipt = CandidateAssessment & { gateEvidence?: ScenarioGateEvidence };
export interface GenerationReceiptObserver {
  onAssessmentReceipt?(candidate: GeneratedSandboxCandidate, operationKey: string, receipt: GenerationAssessmentReceipt): void;
}
export interface SandboxGenerationContinuationConfig extends Omit<SandboxGenerationConfig, 'runner' | 'bindOperation'>, GenerationReceiptObserver {
  /** Actual durable service; arbitrary runner callbacks are deliberately unsupported. */
  service: AgentSessionService;
  db: AgentTransactionalSql;
  scope: { tenantId: string; jobId: string; environmentId: string };
  /** Stable trusted version of gate policy, directory/pins, namespace and budget period.
   * Parent MUST change this when any of those immutable execution contracts change. */
  executionIdentity: string;
  /** Check current principal, tenant/job ownership and environment binding on every phase. */
  authorize(): Promise<boolean>;
}

/** Replays the existing deterministic adapter from revision zero. Completed phase receipts
 * reconstruct feedback/candidates/costs; only a known durable session permits polling again.
 * No generation binding, external gate or cost callback is ever released. */
export function createPostgresSandboxGenerationContinuation(config: SandboxGenerationContinuationConfig) {
  config = { ...config, job: structuredClone(config.job) };
  const scope = structuredClone(config.scope);
  if (!(config.service instanceof AgentSessionService) || config.job.jobId !== scope.jobId || config.job.customerId !== scope.tenantId
    || typeof config.authorize !== 'function'
    || [scope.tenantId, scope.jobId, scope.environmentId, config.executionIdentity].some(v => typeof v !== 'string' || !v.trim() || v.length > 512)) {
    throw new Error('invalid_sandbox_continuation_config');
  }
  const service = config.service;
  const executionIdentity = config.executionIdentity;
  const authorize = config.authorize;
  const costSink = config.onMeasuredCost;
  const assess = config.assessCandidate;
  const observe = config.onAssessmentReceipt;
  const source = config.knownSecrets;
  const retained = new Set<string>();
  const secrets = () => {
    const values = typeof source === 'function' ? source() : source ?? [];
    if (!Array.isArray(values) || values.some(v => typeof v !== 'string' || !v.length)) throw new Error('invalid_sandbox_continuation_secrets');
    values.forEach(v => retained.add(v));
    return [...retained];
  };
  // Exact plain JSON: never silently persist omitted fields, hooks or accessors.
  const screen = <T>(value: T): T => {
    const seen = new Set<object>();
    const walk = (v: unknown, depth: number): void => {
      if (depth > 80) throw new Error('sandbox_continuation_invalid_json');
      if (v === null || typeof v === 'boolean') return;
      if (typeof v === 'string' && !/[\u0000\uD800-\uDFFF]/u.test(v)) return;
      if (typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0)) return;
      if (!v || typeof v !== 'object' || seen.has(v)
        || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) throw new Error('sandbox_continuation_invalid_json');
      seen.add(v);
      const keys = Reflect.ownKeys(v);
      if (keys.some(k => typeof k !== 'string') || (Array.isArray(v) && (keys.length !== v.length + 1 || !Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean)))) throw new Error('sandbox_continuation_invalid_json');
      for (const k of keys as string[]) {
        if (Array.isArray(v) && k === 'length') continue;
        const d = Object.getOwnPropertyDescriptor(v, k)!;
        if (!d.enumerable || !Object.hasOwn(d, 'value') || /[\u0000\uD800-\uDFFF]/u.test(k)) throw new Error('sandbox_continuation_invalid_json');
        walk(d.value, depth + 1);
      }
      seen.delete(v);
    };
    walk(value, 0);
    const encoded = JSON.stringify(value);
    const current = secrets();
    if (Buffer.byteLength(encoded, 'utf8') > 4_000_000 || containsSecret(encoded, current)
      || current.some(s => encoded.includes(s) || encoded.includes(JSON.stringify(s).slice(1, -1)))) throw new Error('sandbox_continuation_unsafe_payload');
    return JSON.parse(encoded) as T;
  };
  const auth = async () => {
    secrets();
    if (await authorize() !== true) throw new Error('sandbox_continuation_unauthorized');
    secrets();
  };
  secrets();
  const store = new PostgresTextCheckpointStore(config.db);
  const jobId = `sandbox-continuation-v1:${executionDigest(scope)}`;
  const keyFor = (kind: string, id: string, input: unknown): CheckpointKey => ({
    jobId, kind: `sandbox_continuation_${kind}_v1`, id: executionDigest(id), inputDigest: executionDigest(screen(input)),
  });
  const pack = (key: CheckpointKey, payload: unknown) => screen({ version: 1, scope, key, payload, payloadDigest: executionDigest(screen(payload)) });
  const unpack = <T>(key: CheckpointKey, raw: unknown): T => {
    const e = screen(raw) as ReturnType<typeof pack>;
    if (!e || e.version !== 1 || executionDigest(e.scope) !== executionDigest(scope) || executionDigest(e.key) !== executionDigest(key)
      || e.payloadDigest !== executionDigest(e.payload)) throw new Error('sandbox_continuation_receipt_conflict');
    return screen(e.payload) as T;
  };
  // Local database-only work: claim AND completion commit atomically. No stale binding
  // can be left by a crash between these statements; callbacks must never be retried.
  const immutable = async <T>(key: CheckpointKey, payload: T): Promise<T> => {
    await auth();
    const result = await config.db.transaction(async tx => {
      const atomic = new PostgresTextCheckpointStore({ query: (sql, params) => tx.query(sql, params), transaction: fn => fn(tx) });
      const claim = await atomic.claim(key);
      await auth();
      if (claim.state === 'completed') return unpack<T>(key, claim.value);
      if (claim.state !== 'claimed') throw new Error('sandbox_continuation_pending_reconciliation');
      await atomic.complete(key, claim.token, pack(key, payload));
      await auth();
      return screen(payload);
    });
    await auth();
    return screen(result);
  };
  const once = async <T>(key: CheckpointKey, operation: () => Promise<T>): Promise<T> => {
    await auth();
    const claim = await store.claim(key);
    await auth();
    if (claim.state === 'completed') return unpack<T>(key, claim.value);
    if (claim.state !== 'claimed') throw new Error('sandbox_continuation_pending_reconciliation');
    const payload = screen(await operation());
    await auth();
    await store.complete(key, claim.token, pack(key, payload));
    await auth();
    return screen(payload);
  };
  const run = async <T>(spec: AgentTaskSpec<T>): Promise<AgentTaskOutcome<T>> => {
    await auth();
    const taskKey = taskKeyFor(spec.job.jobId, spec.role, spec.purpose, spec.attempt ?? 1);
    // Zod's trusted generated schema may carry non-enumerable implementation metadata.
    // Normalize that generated document only; external requests/receipts remain exact JSON.
    const key = keyFor('agent', taskKey, { executionIdentity, job: spec.job, role: spec.role, purpose: spec.purpose,
      attempt: spec.attempt ?? 1, message: spec.message, output: { name: spec.output.name, schema: JSON.parse(JSON.stringify(outputJsonSchema(spec.output.schema))) },
      budgetMicroUsd: spec.budgetMicroUsd, jobCapMicroUsd: spec.jobCapMicroUsd });
    const claim = await store.claim(key);
    await auth();
    if (claim.state === 'completed') return unpack<AgentTaskOutcome<T>>(key, claim.value);
    if (claim.state !== 'claimed') throw new Error('sandbox_continuation_agent_outcome_unknown');
    const outcome = screen(await service.run({ ...spec, knownSecrets: secrets() }));
    await auth();
    if (outcome.taskKey !== taskKey) throw new Error('sandbox_continuation_task_identity_conflict');
    if (outcome.status === 'pending') {
      // A null ID includes create-in-flight, rate limit and unknown create recovery.
      // None is authority to release an operation or call create again here.
      if (outcome.sessionId) {
        const pendingKey = keyFor('session', taskKey, { agentInputDigest: key.inputDigest });
        await config.db.transaction(async tx => {
          const atomic = new PostgresTextCheckpointStore({ query: (sql, params) => tx.query(sql, params), transaction: fn => fn(tx) });
          const saved = await atomic.claim(pendingKey);
          const receipt = { taskKey, sessionId: outcome.sessionId };
          if (saved.state === 'completed') {
            if (executionDigest(unpack(pendingKey, saved.value)) !== executionDigest(receipt)) throw new Error('sandbox_continuation_session_conflict');
          } else if (saved.state === 'claimed') await atomic.complete(pendingKey, saved.token, pack(pendingKey, receipt));
          else throw new Error('sandbox_continuation_pending_reconciliation');
          await auth();
          // Only this known service's durable adopted-session polling phase is released.
          await atomic.release(key, claim.token);
          await auth();
        });
      }
    } else await store.complete(key, claim.token, pack(key, outcome));
    await auth();
    return screen(outcome);
  };
  // Per-call adapter closures avoid cross-worker request state. Every revision retains
  // the original adapter purpose/attempt and its exact feedback/prompt identity.
  return async (raw: SandboxGenerationRequest): Promise<SandboxGenerationResult> => {
    try {
      await auth();
      const request = screen(raw);
      if (request.environment.id !== scope.environmentId) throw new Error('sandbox_continuation_environment_conflict');
      const adapter = createSandboxGenerationAdapter({ ...config, knownSecrets: secrets, runner: { run },
        async bindOperation(operationKey, requestDigest) {
          try {
            await immutable(keyFor('binding', operationKey, { requestDigest, executionIdentity, request }), { request, requestDigest, executionIdentity });
            return 'bound';
          } catch (error) {
            if (error instanceof Error && error.message === 'text_checkpoint_identity_conflict') return 'conflict';
            throw error;
          }
        },
        onMeasuredCost: entry => once(keyFor('cost', entry.taskKey, entry), async () => { await costSink(screen(entry)); return null; }).then(() => undefined),
        assessCandidate: async (candidate, operationKey) => {
          const receipt = await once(keyFor('gate', operationKey, { executionIdentity, candidate }), () => assess(screen(candidate), operationKey));
          await auth();
          observe?.(screen(candidate), operationKey, screen(receipt));
          await auth();
          return receipt;
        },
      });
      const result = await adapter(request);
      await auth();
      if (result.status === 'blocked' && result.taskKey === undefined) delete result.taskKey;
      return screen(result);
    } catch {
      // Never return partially replayed material when authorization or screening fails.
      return { status: 'blocked', reason: 'continuation_unresolved', candidates: [], dropped: [], costs: [] };
    }
  };
}
