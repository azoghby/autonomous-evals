import { StartRunInput } from "@/components/sandbox/contract";
import { jsonError, readJson, requireViewer } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { getSandboxService } from "@/server/sandbox-service";

const DRAFT_ID = /^drf_[0-9a-f-]{36}$/;

export async function POST(req: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const rl = await rateLimit(`sandbox-runs:${auth.viewer.id}`, 20, 3600);
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  const { draftId } = await params;
  if (!DRAFT_ID.test(draftId)) return jsonError(404, "Draft not found");
  // An empty body means defaults (k = 5).
  const text = await req.text();
  const body = await readJson(new Request(req.url, { method: "POST", body: text.trim() === "" ? "{}" : text }), StartRunInput);
  if (!body.ok) return body.res;
  try {
    const out = await getSandboxService().startRun(auth.viewer.id, draftId, { k: body.data.k });
    return out.ok ? Response.json({ runId: out.runId }, { status: 201 }) : jsonError(out.status, out.error);
  } catch (err) {
    console.error("start sandbox run failed", err);
    return jsonError(500, "Could not start run");
  }
}
