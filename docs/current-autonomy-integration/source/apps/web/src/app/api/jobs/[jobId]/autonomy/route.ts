import { currentAutonomy, autonomyUnavailable } from '@/server/current-autonomy-runtime';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const app = currentAutonomy();
  if (!app) return autonomyUnavailable();
  return app.bootstrap(request, (await context.params).jobId);
}
