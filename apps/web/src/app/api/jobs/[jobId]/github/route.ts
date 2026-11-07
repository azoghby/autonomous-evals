import { jsonError, readJson } from "@/server/http";
import { withIdempotency, IdempotencyInProgressError } from "@/server/idempotency";
import { rateLimit } from "@/server/rate-limit";
import { GithubTargetInput } from "@/server/github-pr";
import { authorizeOwner, connectRepo, connectionStatus, disconnectRepo, mapError } from "@/server/github-service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ jobId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const a = await authorizeOwner((await ctx.params).jobId);
  if (a.res) return a.res;
  return Response.json(await connectionStatus(a.job.id));
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const a = await authorizeOwner((await ctx.params).jobId);
  if (a.res) return a.res;
  await disconnectRepo(a.job.id);
  return Response.json({ ok: true });
}

/** Saves the repo target and encrypted fine-grained token. Response never contains the token. */
export async function POST(req: Request, ctx: Ctx) {
  const a = await authorizeOwner((await ctx.params).jobId);
  if (a.res) return a.res;
  const key = req.headers.get("idempotency-key")?.trim();
  if (!key || key.length > 200) return jsonError(400, "Idempotency-Key header is required (max 200 chars)");
  const body = await readJson(req, GithubTargetInput);
  if (!body.ok) return body.res;
  const rl = await rateLimit(`github-connect:${a.me.id}`, 10, 600);
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  try {
    const out = await withIdempotency(`${a.me.id}:jobs.github:${a.job.id}:${key}`, async () => {
      try {
        await connectRepo(a.job, body.data);
        return { status: 200, body: await connectionStatus(a.job.id) };
      } catch (err) {
        const m = mapError(err, body.data.token);
        if (m.status >= 500) throw err;
        return { status: m.status, body: m.body };
      }
    });
    return Response.json(out.body, { status: out.status });
  } catch (err) {
    if (err instanceof IdempotencyInProgressError) return jsonError(409, err.message);
    return jsonError(500, "Could not save the repository");
  }
}
