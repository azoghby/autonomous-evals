import { humanDataReview } from '@/server/data-production';

const failure = () => Response.json({ error: 'Data review unavailable' }, { status: 403 });
export async function GET(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await ctx.params;
    return Response.json(await humanDataReview(jobId, new URL(req.url).searchParams.get('digest') ?? ''));
  } catch { return failure(); }
}
export async function POST(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  try {
    // Same-origin JSON POST; cookie authentication alone is insufficient CSRF protection.
    if (req.headers.get('origin') !== new URL(req.url).origin || !/^application\/json(?:;|$)/i.test(req.headers.get('content-type') ?? '')) return failure();
    const reader = req.body?.getReader();
    if (!reader) return failure();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 500_000) { await reader.cancel(); return failure(); }
      chunks.push(part.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['digest', 'receiptId', 'decision', 'reviewed'].includes(k))) return failure();
    const { jobId } = await ctx.params;
    return Response.json(await humanDataReview(jobId, body.digest, { receiptId: body.receiptId, decision: body.decision, reviewed: body.reviewed }));
  } catch { return failure(); }
}
