import { z } from 'zod';
import type { AgentTransactionalSql } from '../../agents/postgres-ports';
import type { DiscoveryRejection, EvaluationDataStore, EvaluationDataTask } from './acquisition';
import { validateDiscoveryRejection } from './discovery/rejection';
import { reviewDigest } from './binding';
import { inspectDataSafety } from './quality';

const MAX_BYTES = 500_000;
const invalid = () => new Error('evaluation_data_persistence_invalid');
const conflict = () => new Error('evaluation_data_persistence_identity_conflict');
const text = z.string();
const id = text.regex(/^[A-Za-z0-9_-]{1,96}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = text.refine(value => value.trim().length > 0 && Number.isFinite(Date.parse(value)));
const digest = text.regex(/^[a-f0-9]{64}$/);
const status = z.enum(['pending', 'approved', 'rejected']);
const uses = z.array(z.enum(['evaluation', 'generation', 'redistribution']));
const review = z.strictObject({ status, reviewerId: text, reviewedAt: text, notes: text });
const specSchema = z.strictObject({ taskId: id, jobId: id, description: text, requirements: z.array(z.strictObject({
  id, description: text, minimumCases: count,
})), factualAnswersRequired: z.boolean(), targetId: text, requiredUses: uses.optional() });
const verification = z.strictObject({ contextDigest: digest.optional(), status,
  method: z.enum(['independent_evidence', 'expert']), verifierId: text,
  independentOfTarget: z.boolean(), independentOfGenerator: z.boolean(), evidenceSourceIds: z.array(text),
  reviewedAnswer: text, reviewedAt: text, rationale: text,
  expertAttestation: z.strictObject({ qualified: z.boolean(), consentToEvaluation: z.boolean(), contributionId: text,
    contributionContextDigest: digest.optional() }).optional(),
});
const source = z.strictObject({ id: text, url: text, content: text,
  license: z.strictObject({ name: text, url: text, permission: z.enum(['allowed', 'denied', 'unknown', 'mixed']), allowedUses: uses }),
  provenance: z.strictObject({ origin: z.enum(['public', 'customer', 'expert', 'synthetic', 'evaluation_target']),
    producerId: text, retrievedAt: text, contentHash: text }), review,
});
const candidate = z.strictObject({ id: text, input: text, requirementIds: z.array(text), synthetic: z.boolean(),
  generatorId: text.optional(), sourceIds: z.array(text), expectedAnswer: text.optional(), verification: verification.optional() });
const phase = z.enum(['discovery', 'generation', 'expert', 'complete']);
const rejection = z.custom<DiscoveryRejection>(value => {
  try { validateDiscoveryRejection(value); return true; } catch { return false; }
});
const recordSchema = z.strictObject({ taskId: id, revision: count, spec: specSchema, requestHash: digest,
  state: z.enum(['acquiring', 'ready', 'waiting_for_data', 'waiting_for_expert']), phase,
  sources: z.array(source), cases: z.array(candidate),
  assessment: z.strictObject({ status: z.enum(['sufficient', 'insufficient', 'unassessed']),
    factualCorrectness: z.enum(['assessed', 'unassessed']), acceptedCaseIds: z.array(text), approvedAnswerCaseIds: z.array(text),
    coverage: z.array(z.strictObject({ requirementId: text, minimumCases: count, acceptedCases: count, covered: z.boolean() })),
    issues: z.array(z.strictObject({ code: text, caseId: text.optional(), sourceId: text.optional() })),
  }),
  decisions: z.array(z.strictObject({ id: text, phase, outcome: text, at: timestamp, rejection: rejection.optional() })
    .refine(row => !row.rejection || row.phase === 'discovery' && row.outcome === 'discovery_rejected')), updatedAt: timestamp,
});

/** Reject lossy JSON, accessors, non-plain objects, NUL and lone UTF-16 surrogates.
 * Valid surrogate pairs (including emoji) are preserved. No user-defined serialization runs. */
function encode(value: unknown): string {
  const seen = new Set<object>();
  function walk(item: unknown, depth: number): void {
    if (depth > 64) throw invalid();
    if (typeof item === 'string') { if (/[\u0000\uD800-\uDFFF]/u.test(item)) throw invalid(); return; }
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) throw invalid();
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw invalid();
    seen.add(item);
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== 'string')) throw invalid();
    if (Array.isArray(item) && (keys.length !== item.length + 1 || item.length > MAX_BYTES)) throw invalid();
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      walk(key, depth + 1);
      const property = Object.getOwnPropertyDescriptor(item, key)!;
      if (!property.enumerable || !('value' in property)) throw invalid();
      walk(property.value, depth + 1);
    }
    seen.delete(item);
  }
  walk(value, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) throw invalid();
  return json;
}

export interface PostgresEvaluationDataScope {
  /** Trusted authorization context, never derived from candidate/provider data. */
  tenantId: string;
  jobId: string;
  /** Evaluated on every operation, allowing current policy to reject old records. */
  knownSecrets?: readonly string[] | (() => readonly string[]);
}
type Row = { record: unknown; revision: string | number };

/** No migration or external calls. db.transaction must pin a READ COMMITTED connection,
 * roll back thrown errors and never retry its callback (pooledCalendarDatabase is compatible). */
export function createPostgresEvaluationDataStore(db: AgentTransactionalSql, scope: PostgresEvaluationDataScope): EvaluationDataStore {
  const { tenantId, jobId, knownSecrets = [] } = scope;
  if (!id.safeParse(tenantId).success || !id.safeParse(jobId).success) throw invalid();
  const secrets = () => typeof knownSecrets === 'function' ? knownSecrets() : knownSecrets;
  function validate(value: unknown, taskId: string): EvaluationDataTask {
    const json = encode(value);
    const parsed: unknown = JSON.parse(json);
    if (!recordSchema.safeParse(parsed).success) throw invalid();
    const record = parsed as EvaluationDataTask;
    if (record.taskId !== taskId || record.spec.taskId !== taskId || record.spec.jobId !== jobId
      || !inspectDataSafety(record, secrets()).safe) throw invalid();
    return record;
  }
  function decode(row: Row, taskId: string): EvaluationDataTask {
    const record = validate(row.record, taskId);
    if (!/^(0|[1-9][0-9]*)$/.test(String(row.revision)) || Number(row.revision) !== record.revision) throw invalid();
    return record;
  }
  function key(taskId: string): unknown[] {
    if (!id.safeParse(taskId).success || !inspectDataSafety({ tenantId, jobId, taskId }, secrets()).safe) throw invalid();
    return [tenantId, jobId, taskId];
  }
  function sameIdentity(a: EvaluationDataTask, b: EvaluationDataTask): void {
    if (a.requestHash !== b.requestHash || reviewDigest(a.spec) !== reviewDigest(b.spec)) throw conflict();
  }
  // Storage/driver errors may contain SQL parameters; expose only fixed diagnostics.
  async function safe<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch (error) {
      if (error instanceof Error && [invalid().message, conflict().message].includes(error.message)) throw new Error(error.message);
      throw new Error('evaluation_data_persistence_failed');
    }
  }
  const select = 'SELECT record, revision FROM evaluation_data_persistence.tasks WHERE tenant_id = $1 AND job_id = $2 AND task_id = $3';
  return {
    get: taskId => safe(async () => {
      const rows = (await db.query<Row>(select, key(taskId))).rows;
      return rows[0] ? decode(rows[0], taskId) : null;
    }),
    insertIfAbsent: input => safe(async () => {
      const snapshot = JSON.parse(encode(input)) as EvaluationDataTask;
      const params = key(snapshot.taskId);
      const record = validate(snapshot, snapshot.taskId);
      if (record.revision !== 0) throw invalid();
      return db.transaction(async tx => {
        const inserted = (await tx.query<Row>('INSERT INTO evaluation_data_persistence.tasks (tenant_id, job_id, task_id, revision, record) VALUES ($1, $2, $3, 0, $4::jsonb) ON CONFLICT (tenant_id, job_id, task_id) DO NOTHING RETURNING record, revision', [...params, encode(record)])).rows;
        const row = inserted[0] ?? (await tx.query<Row>(select, params)).rows[0];
        if (!row) throw invalid();
        const stored = decode(row, record.taskId);
        sameIdentity(stored, record);
        return { inserted: inserted.length > 0, record: stored };
      });
    }),
    compareAndSet: (taskId, expectedRevision, input) => safe(async () => {
      const params = key(taskId);
      const next = validate(input, taskId);
      if (!count.safeParse(expectedRevision).success || next.revision !== expectedRevision + 1) throw invalid();
      return db.transaction(async tx => {
        const row = (await tx.query<Row>(`${select} FOR UPDATE`, params)).rows[0];
        if (!row) return null;
        const current = decode(row, taskId);
        sameIdentity(current, next);
        if (current.revision !== expectedRevision) return null;
        if (next.decisions.length < current.decisions.length || current.decisions.some((decision, index) => reviewDigest(decision) !== reviewDigest(next.decisions[index]))) throw invalid();
        const saved = (await tx.query<Row>('UPDATE evaluation_data_persistence.tasks SET record = $4::jsonb, revision = $5 WHERE tenant_id = $1 AND job_id = $2 AND task_id = $3 AND revision = $6 RETURNING record, revision', [...params, encode(next), next.revision, expectedRevision])).rows[0];
        return saved ? decode(saved, taskId) : null;
      });
    }),
  };
}
