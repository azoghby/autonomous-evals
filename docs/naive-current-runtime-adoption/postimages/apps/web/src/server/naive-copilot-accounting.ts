import { settleCost } from '@ae/core/db/cost-settlement';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';

/** Trusted recovery worker only. No request body or provider callback supplies usage.
 * The retained terminal measurement is delivered to the actual application cost sink,
 * atomically with acknowledgement. Retries after lost commit acknowledgements are safe.
 * A changed owner/environment or legacy conflicting receipt remains unacknowledged. */
export async function deliverCopilotCost(db: AgentTransactionalSql, dispatchId: string) {
  try {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(dispatchId)) throw Error();
    // Discover the canonical job before locking, preserving job -> outbox order.
    const found = (await db.query<{job_id:string}>(
      'SELECT job_id FROM naive_copilot.cost_outbox WHERE dispatch_id=$1', [dispatchId])).rows[0];
    if (!found) return {status:'pending' as const};
    return await db.transaction(async tx => {
      await tx.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [found.job_id]);
      const row = (await tx.query<{
        job_id:string;customer_id:string;environment:'test'|'live';session_id:string;
        consumed_micro_usd:string|number;delivered_at:unknown;
      }>(`SELECT o.* FROM naive_copilot.cost_outbox o
        JOIN naive_copilot.dispatches d ON d.id=o.dispatch_id
        WHERE o.dispatch_id=$1 AND o.job_id=$2
        AND d.state IN ('completed','failed') AND d.session_id=o.session_id
        AND d.consumed_micro_usd=o.consumed_micro_usd
        AND d.identity->'task'->>'jobId'=o.job_id::text
        AND d.identity->'task'->>'customerId'=o.customer_id::text
        AND d.identity->'task'->>'environment'=o.environment
        FOR UPDATE OF o`, [dispatchId,found.job_id])).rows[0];
      if (!row) throw Error();
      const microUsd=Number(row.consumed_micro_usd);
      if (!Number.isSafeInteger(microUsd)||microUsd<0) throw Error();
      // Copilot is not a member of the legacy CostEntry.agent enum. Retain the role
      // in metadata instead of falsely attributing the charge to another agent.
      const result=await settleCost({transaction:fn=>fn(tx)}, {
        kind:'job',id:row.job_id,ownerId:row.customer_id,environment:row.environment,
      }, {source:'naive',sessionId:row.session_id,microUsd,
        meta:{measured:true,purpose:'copilot-initial-dispatch',role:'copilot',dispatchId}});
      if (!row.delivered_at) await tx.query(
        'UPDATE naive_copilot.cost_outbox SET delivered_at=clock_timestamp() WHERE dispatch_id=$1 AND delivered_at IS NULL', [dispatchId]);
      return {status:'delivered' as const,inserted:result.inserted,microUsd};
    });
  } catch { throw Error('copilot_accounting_unavailable'); }
}
