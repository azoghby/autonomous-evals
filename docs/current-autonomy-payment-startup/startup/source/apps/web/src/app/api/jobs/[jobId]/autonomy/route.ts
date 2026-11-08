import { currentAutonomy, autonomyUnavailable } from '@/server/current-autonomy-runtime';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const startup = await currentAutonomy();
  if (!startup) return autonomyUnavailable();
  return startup.bootstrap(request, (await context.params).jobId);
}
