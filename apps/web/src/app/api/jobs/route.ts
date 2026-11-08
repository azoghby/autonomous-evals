import { IntakeInput } from "@ae/core/contracts/index";
import { jsonError, readJson, requireViewer } from "@/server/http";
import { withIdempotency, IdempotencyInProgressError } from "@/server/idempotency";
import { createJob } from "@/server/create-job";
import { listMyJobs } from "@/server/queries";
import { rateLimit, clientIp } from "@/server/rate-limit";
import { assertHuman } from "@/server/bot";

export async function GET() {
  const jobs = await listMyJobs();
  if (!jobs) return jsonError(401, "Authentication required");
  return Response.json({ jobs });
}

export async function POST(req: Request) {
  const blocked = await assertHuman(); if (blocked) return blocked;
  const rl = await rateLimit(`jobs:${clientIp(req)}`, 20, 600);
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const key = req.headers.get("idempotency-key")?.trim();
  if (!key || key.length > 200) return jsonError(400, "Idempotency-Key header is required (max 200 chars)");
  const body = await readJson(req, IntakeInput, 1024 * 1024) /* 200 KB trace, JSON-escaped */;
  if (!body.ok) return body.res;
  try {
    const out = await withIdempotency(`${auth.viewer.id}:jobs.create:${key}`, async () => {
      const { jobId } = await createJob({ customerId: auth.viewer.id, idempotencyKey: key, intake: body.data });
      return { status: 201, body: { jobId } };
    });
    return Response.json(out.body, { status: out.status, headers: out.replayed ? { "Idempotent-Replayed": "true" } : {} });
  } catch (err) {
    if (err instanceof IdempotencyInProgressError) return jsonError(409, err.message);
    console.error("create job failed", err);
    return jsonError(500, "Could not create job");
  }
}
