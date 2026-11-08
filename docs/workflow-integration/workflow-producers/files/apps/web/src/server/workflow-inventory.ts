import 'server-only';
import { canonicalJson } from '@ae/core/evals/text/index';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import type { CheckpointKey, TextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import { publishStructuredInventory } from './structured-progress-inventory';
import { inventoryPlanSchema, type InventoryPlan } from './structured-progress';

type Scope = { tenantId: string; jobId: string; environment: 'test' | 'live' };
type Associations = { runId: string; suiteDigest: string; scenarioIds: string[]; branchId?: string };
/** Captures identities produced by the actual core factory, not guessed hashes.
 * A separate instance belongs to one authenticated Workflow invocation. */
export function createWorkflowInventory(db: AgentTransactionalSql, scope: Scope) {
  const phase = new AsyncLocalStorage<Associations>();
  async function publish(key?: CheckpointKey, acquisitionTaskIds: string[] = []) {
    await db.transaction(async tx => {
      // Serialize first publication as well as updates. No lock spans external I/O.
      const job = (await tx.query<{ customer_id: string; environment: string }>(
        'SELECT customer_id, environment FROM jobs WHERE id = $1 FOR UPDATE', [scope.jobId])).rows[0];
      if (!job || job.customer_id !== scope.tenantId || job.environment !== scope.environment) throw new Error('workflow_inventory_scope');
      const row = (await tx.query<{ revision: string | number; plan: unknown }>(
        'SELECT revision, plan FROM structured_progress.inventory WHERE job_id = $1', [scope.jobId])).rows[0];
      const plan: InventoryPlan = row ? inventoryPlanSchema.parse(row.plan) : { checkpoints: [], acquisitionTaskIds: [] };
      for (const id of acquisitionTaskIds) if (!plan.acquisitionTaskIds.includes(id)) plan.acquisitionTaskIds.push(id);
      const kinds = { design: 'text_design', run_identity: 'text_run', run_result: 'text_run', investigation: 'text_investigation', calendar_run: 'calendar_run', calendar_investigation: 'calendar_investigation' } as const;
      const format = key ? kinds[key.kind as keyof typeof kinds] : undefined;
      if (key && format) {
        if (key.jobId !== scope.jobId) throw new Error('workflow_inventory_scope');
        const associations = format === 'text_design' ? {} : phase.getStore();
        if (!associations) throw new Error('workflow_inventory_associations_required');
        // Core run_identity and run_result use the same digest. Planning the result
        // when run_identity is first claimed precedes every target dispatch.
        const entry = { key: { ...key, kind: key.kind === 'run_identity' ? 'run_result' : key.kind },
          format, phase: format === 'text_design' ? 'planning' as const : format.endsWith('_run') ? 'running' as const : 'investigating' as const,
          ...associations };
        const old = plan.checkpoints.find(p => p.key.kind === entry.key.kind && p.key.id === entry.key.id);
        if (old && canonicalJson(old) !== canonicalJson(entry)) throw new Error('workflow_inventory_identity_conflict');
        if (!old) plan.checkpoints.push(entry);
      }
      // There may be no public checkpoint during calendar suite freeze. Do not
      // manufacture a completed phase from that private internal checkpoint.
      if (!plan.checkpoints.length && !plan.acquisitionTaskIds.length) return;
      await publishStructuredInventory(tx, scope, row ? Number(row.revision) : null, plan);
    });
  }
  return {
    phase<T>(associations: Associations, action: () => Promise<T>): Promise<T> {
      return phase.run(JSON.parse(JSON.stringify(associations)) as Associations, action);
    },
    touch: () => publish(),
    acquisition: (taskIds: string[]) => publish(undefined, taskIds),
    wrap(base: TextCheckpointStore): TextCheckpointStore {
      const mutate = async <T>(key: CheckpointKey, action: () => Promise<T>): Promise<T> => {
        await publish(key); // durable expected blocker BEFORE claim/dispatch
        try { return await action(); }
        finally { await publish(key); } // failed publication blocks continuation
      };
      return {
        claim: key => mutate(key, () => base.claim(key)),
        get: key => base.get(key),
        complete: (key, token, value) => mutate(key, () => base.complete(key, token, value)),
        release: (key, token) => mutate(key, () => base.release(key, token)),
        markAmbiguous: (key, token) => mutate(key, () => base.markAmbiguous(key, token)),
      };
    },
  };
}
