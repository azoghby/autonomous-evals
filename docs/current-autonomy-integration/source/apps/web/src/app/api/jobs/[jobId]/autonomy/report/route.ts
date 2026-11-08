import { currentAutonomy, autonomyUnavailable } from '@/server/current-autonomy-runtime';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const app = currentAutonomy();
  if (!app) return autonomyUnavailable();
  return app.publication(request, (await context.params).jobId);
}
