import { currentAutonomy } from '../server/current-autonomy-runtime';

/** Bounded durable scheduler wrapper. SQL operation keys retain company/run authority;
 * the scheduler Workflow run ID never impersonates the customer's existing Workflow run. */
export async function currentAutonomyWorkflow() {
  'use workflow';
  return advanceDueJobsStep();
}
async function advanceDueJobsStep() {
  'use step';
  const app = currentAutonomy();
  if (!app) throw new Error('current_autonomy_owner_composition_unavailable');
  return app.advanceDueJobs();
}
// Unknown external usage must reconcile through durable company operations on a later tick.
advanceDueJobsStep.maxRetries = 0;
