import 'server-only';
import { z } from 'zod';
import { readBoundedJson } from './body-limit';
import type { internalTaskDependencies } from './naive-internal-runtime';
const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('issue'), requestId: z.uuid() }).strict(),
  z.object({ action: z.literal('revoke'), taskId: z.uuid() }).strict(),
]);
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
export const internalTaskUnavailable = () => Response.json({ error: 'Internal task authorization unavailable' }, { status: 503, headers });
export function createInternalTaskApi(deps: ReturnType<typeof internalTaskDependencies>) {
  return async (request: Request, jobId: string): Promise<Response> => {
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
    try {
      const customerId = await deps.currentOwner();
      if (!customerId) return json({ error: 'Authentication required' }, 401);
      if (!z.uuid().safeParse(jobId).success) return json({ error: 'Job not found' }, 404);
      const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
      if (!origin || origin !== new URL(request.url).origin || site && site !== 'same-origin') return json({ error: 'Same-origin request required' }, 403);
      if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return json({ error: 'JSON required' }, 415);
      const raw = await readBoundedJson(request, 2048);
      if (!raw.ok) return json({ error: 'Invalid bounded request' }, raw.res.status);
      const body = Body.safeParse(raw.value);
      if (!body.success) return json({ error: 'Invalid task request' }, 400);
      if (body.data.action === 'issue') {
        if (!await deps.allowIssue(customerId)) return json({ error: 'Too many task requests' }, 429);
        return json(await deps.issue(customerId, jobId, body.data.requestId));
      }
      await deps.revoke(customerId, jobId, body.data.taskId);
      return json({ revoked: true, boundary: 'Future reads are blocked. Previously returned data cannot be recalled.' });
    } catch { return internalTaskUnavailable(); }
  };
}
