import { CostEntry } from '@ae/core/contracts/index';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';

/** Same transaction inserts the canonical cost and its dedup key; conflicts never overwrite facts. */
export async function upsertWorkflowCost(sql: AgentTransactionalSql, raw: unknown): Promise<void> {
  const e = CostEntry.parse(raw);
  const key = e.meta?.idempotencyKey;
  if (e.source === 'naive' && (typeof key !== 'string' || key !== `naive:${e.sessionId}`)) throw new Error('measured_cost_identity_required');
  await sql.transaction(async tx => {
    if (typeof key === 'string') {
      const claimed = await tx.query<{ payload: unknown }>(`INSERT INTO workflow_integration.cost_keys(job_id,key,payload)
        VALUES($1,$2,$3::jsonb) ON CONFLICT(key) DO NOTHING RETURNING payload`, [e.jobId, key, JSON.stringify(e)]);
      if (!claimed.rows.length) {
        const existing = await tx.query<{ agrees: boolean }>('SELECT payload=$3::jsonb AS agrees FROM workflow_integration.cost_keys WHERE job_id=$1 AND key=$2', [e.jobId,key,JSON.stringify(e)]);
        if (existing.rows[0]?.agrees !== true) throw new Error('measured_cost_identity_conflict');
        return;
      }
    }
    await tx.query(`INSERT INTO costs(job_id,source,agent,session_id,micro_usd,meta) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
      [e.jobId,e.source,e.agent??null,e.sessionId??null,e.microUsd,JSON.stringify(e.meta)]);
  });
}
