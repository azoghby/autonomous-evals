import { currentAutonomy } from '../server/current-autonomy-runtime';
export async function currentAutonomyWorkflow() {
  'use workflow';
  return advanceDueJobsStep();
}
async function advanceDueJobsStep() {
  'use step';
  // The owner factory is resolved here, inside the Workflow step isolate, not just in HTTP startup.
  const startup = await currentAutonomy();
  if (!startup) throw new Error('current_autonomy_owner_adapters_unconfigured');
  return startup.advanceDueJobs();
}
// Lost effect acknowledgement is recovered through durable receipts, never blind step redispatch.
advanceDueJobsStep.maxRetries = 0;
