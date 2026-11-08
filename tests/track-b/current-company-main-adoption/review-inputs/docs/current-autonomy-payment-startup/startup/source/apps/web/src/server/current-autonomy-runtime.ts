import 'server-only';
import { createCurrentIsolateStartup } from './current-payment-startup';
import { loadCurrentAutonomyOwner } from './current-autonomy-owner';

/** Imported by server routes and by the durable step bundle. Every isolate resolves the same
 * reviewed factory; there is no installCurrentAutonomy call depending on another process. */
export const currentAutonomy = createCurrentIsolateStartup(loadCurrentAutonomyOwner);
export function autonomyUnavailable() {
  return Response.json({error:'Current autonomous owner adapters are not configured'}, {
    status:503,headers:{'Cache-Control':'private, no-store'},
  });
}
