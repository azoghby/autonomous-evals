import { createInternalTaskDependencies } from '@/server/naive-internal-runtime';
import { createInternalTaskApi, internalTaskUnavailable } from '@/server/naive-internal-task-api';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try { return await createInternalTaskApi(createInternalTaskDependencies())(request, (await context.params).jobId); }
  catch { return internalTaskUnavailable(); }
}
