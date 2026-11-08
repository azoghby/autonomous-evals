import type { AgentSqlExecutor } from '@ae/core/agents/postgres-ports';
import { CHAT_LIMITS, ProgressSnapshotSchema, type ProgressSnapshot } from '@ae/core/reporting/chat/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never { throw new Error('internal_progress_unavailable'); }
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}
function time(value: unknown): string {
  const iso = value instanceof Date ? value.toISOString() : value;
  if (typeof iso !== 'string' || !ProgressSnapshotSchema.shape.observedAt.safeParse(iso).success || !Number.isFinite(Date.parse(iso))) invalid();
  return new Date(iso).toISOString();
}
function amount(value: unknown): number {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))) invalid();
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) invalid();
  return n;
}
function bounded<T>(rows: T[], limit: number): T[] { if (rows.length > limit) invalid(); return rows; }

/** Caller must provide a pinned, consistent transaction and authorize the task first.
 * This is a projection, not authentication. Recheck exact persisted ownership while
 * locking the job against owner changes; there is deliberately no operator bypass.
 * LIMIT + 1 fails closed rather than presenting truncated counts as complete.
 * Evidence references identify persisted rows, never text/locations from evidence.
 */
export async function readInternalProgress(tx: AgentSqlExecutor, scope: { customerId: string; jobId: string }): Promise<ProgressSnapshot> {
  try {
    const customerId = id(scope.customerId), jobId = id(scope.jobId);
    const jobs = await tx.query<{ id: string; state: unknown; updated_at: unknown }>(
      'SELECT id, state, updated_at FROM jobs WHERE id = $1 AND customer_id = $2 FOR SHARE', [jobId, customerId]);
    if (jobs.rows.length !== 1 || jobs.rows[0]!.id !== jobId) invalid();
    const job = jobs.rows[0]!;
    let observedAt = time(job.updated_at);
    const observe = (value: unknown) => { const at = time(value); if (at > observedAt) observedAt = at; return at; };
    const milestones = bounded((await tx.query<{ id: unknown; milestone: unknown; created_at: unknown }>(
      'SELECT id, milestone, created_at FROM progress_events WHERE job_id = $1 ORDER BY created_at, id LIMIT $2', [jobId, CHAT_LIMITS.milestones + 1])).rows, CHAT_LIMITS.milestones).map(row => {
      const ref = id(row.id);
      if (typeof row.milestone !== 'string' || row.milestone.length > 100) invalid();
      return { id: ref, milestone: ['planning', 'running', 'investigating', 'delivered'].includes(row.milestone) ? row.milestone : 'other', at: observe(row.created_at), evidenceRef: `progress:${ref}` };
    });
    const findings = bounded((await tx.query<{ id: unknown; status: unknown; severity: unknown; evidence_count: unknown; created_at: unknown }>(
      "SELECT id, data->>'status' AS status, data->>'severity' AS severity, CASE WHEN jsonb_typeof(data->'evidence') = 'array' THEN jsonb_array_length(data->'evidence') END AS evidence_count, created_at FROM findings WHERE job_id = $1 ORDER BY created_at, id LIMIT $2", [jobId, CHAT_LIMITS.findings + 1])).rows, CHAT_LIMITS.findings).map(row => {
      const ref = id(row.id); observe(row.created_at);
      if (amount(row.evidence_count) < 1) invalid();
      // The schema has no evidence IDs: cite the owning persisted finding row.
      return { id: ref, status: row.status, severity: row.severity, evidenceRefs: [`finding:${ref}`] };
    });
    let total = 0;
    const costs = bounded((await tx.query<{ id: unknown; source: unknown; micro_usd: unknown; created_at: unknown }>(
      'SELECT id, source, micro_usd, created_at FROM costs WHERE job_id = $1 ORDER BY created_at, id LIMIT $2', [jobId, CHAT_LIMITS.costs + 1])).rows, CHAT_LIMITS.costs).flatMap(row => {
      const ref = id(row.id), microUsd = amount(row.micro_usd); observe(row.created_at);
      total += microUsd; if (!Number.isSafeInteger(total)) invalid();
      if (typeof row.source !== 'string' || !['naive', 'naive_proxy', 'ai_gateway'].includes(row.source)) invalid();
      // Proxy costs are a distinct ledger source; never relabel them as Naive.
      return row.source === 'naive_proxy' ? [] : [{ id: ref, source: row.source, microUsd, evidenceRef: `cost:${ref}` }];
    });
    return ProgressSnapshotSchema.parse({ jobId, status: job.state, statusEvidenceRef: `job:${jobId}`, observedAt, milestones, findings, blockers: [], costs,
      // This ledger cannot prove pending/unreported external usage is settled.
      unknownCosts: true });
  } catch { invalid(); }
}
