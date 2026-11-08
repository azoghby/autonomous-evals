import 'server-only';
import { getCurrentCustomer } from './session';
import { getJob } from './job-store';
import { requireCronAuth } from '../app/api/cron/_auth';
import { createCurrentAutonomyApplication, type CurrentAutonomyConfig } from './current-autonomy';

let application: ReturnType<typeof createCurrentAutonomyApplication> | undefined;
/** Owner's server startup imports this once with reviewed production adapters. No env JSON,
 * request payload, mock service, or legacy runner can fill missing authority/transport seams. */
export function installCurrentAutonomy(config: CurrentAutonomyConfig) {
  if (application) throw new Error('current_autonomy_already_installed');
  application = createCurrentAutonomyApplication(config, { viewer: getCurrentCustomer, job: getJob, cron: requireCronAuth });
}
export function currentAutonomy() { return application; }
export function autonomyUnavailable() {
  return Response.json({ error: 'Autonomous owner composition is not configured' }, { status:503, headers:{'Cache-Control':'private, no-store'} });
}
