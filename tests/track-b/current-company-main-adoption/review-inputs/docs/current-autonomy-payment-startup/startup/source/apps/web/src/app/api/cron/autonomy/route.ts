import { start } from 'workflow/api';
import { currentAutonomy, autonomyUnavailable } from '@/server/current-autonomy-runtime';
import { currentAutonomyWorkflow } from '@/workflows/current-autonomy';
import { requireCronAuth } from '../_auth';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const denied = requireCronAuth(request); if (denied) return denied;
  if (!await currentAutonomy()) return autonomyUnavailable();
  const run = await start(currentAutonomyWorkflow, []);
  return Response.json({runId:run.runId}, {status:202});
}
