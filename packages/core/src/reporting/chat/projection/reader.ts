import type { TextCheckpointStore } from '../../../evals/integration/checkpoints.js';
import type { EvaluationDataStore } from '../../../evals/data/acquisition.js';
import type { DurableProgressRead, ProgressProjectionPorts, ProjectionPlan } from './types.js';

/** Ports must share one consistent durable view, including the job/inventory revision.
 * For PostgreSQL use a pinned read-only REPEATABLE READ transaction or immutable
 * versioned read. Do not compose independently created READ COMMITTED stores.
 */
export interface DurableReadView {
  observedAt: string;
  job: DurableProgressRead['job'];
  costs: DurableProgressRead['costs'];
  unknownCosts: boolean;
  checkpoints: Pick<TextCheckpointStore, 'get'>;
  acquisition: Pick<EvaluationDataStore, 'get'>;
}
export interface ConsistentProgressReadPort {
  /** Recheck authorization and inventory revision inside the durable read boundary.
   * Every nested query retains plan.scope and authorized tenant/environment.
   * Must never retry the callback or instantiate providers/agents.
   */
  withRead<T>(plan: ProjectionPlan, read: (view: DurableReadView) => Promise<T>): Promise<T>;
}
/** Uses the existing get-only store shapes; exposes no claim/CAS or external calls. */
export function createDurableProgressReader(port: ConsistentProgressReadPort): ProgressProjectionPorts['reader'] {
  return {
    read: plan => port.withRead(plan, async view => {
      const checkpoints: DurableProgressRead['checkpoints'] = [];
      for (const p of plan.checkpoints) {
        const key = Object.freeze({ ...p.key });
        checkpoints.push({ key, record: await view.checkpoints.get(key) });
      }
      const acquisition: DurableProgressRead['acquisition'] = [];
      for (const taskId of plan.acquisitionTaskIds) acquisition.push({ taskId, record: await view.acquisition.get(taskId) });
      return { scope: { ...plan.scope }, observedAt: view.observedAt, job: view.job, costs: view.costs, unknownCosts: view.unknownCosts, checkpoints, acquisition };
    }),
  };
}
