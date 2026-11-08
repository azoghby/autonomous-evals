import { z } from "zod";
import { jsonError, readJson, requireViewer } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { createApiKey, listApiKeys } from "@/server/api-keys";

const CreateKeyInput = z.object({ name: z.string().trim().min(1).max(80) });

export async function GET() {
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  return Response.json({ keys: await listApiKeys(auth.viewer.id) });
}

export async function POST(req: Request) {
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const rl = await rateLimit(`keys:${auth.viewer.id}`, 20, 600);
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  const body = await readJson(req, CreateKeyInput);
  if (!body.ok) return body.res;
  try {
    const out = await createApiKey(auth.viewer.id, body.data.name);
    return Response.json(out, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("API key limit")) return jsonError(409, err.message);
    console.error("create api key failed", err);
    return jsonError(500, "Could not create API key");
  }
}
