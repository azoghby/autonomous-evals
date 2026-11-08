import { currentAutonomy, autonomyUnavailable } from '@/server/current-autonomy-runtime';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const startup = await currentAutonomy();
  if (!startup) return autonomyUnavailable();
  return startup.publication(request, (await context.params).jobId);
}
