import { SandboxIntakeInput } from "@/components/sandbox/contract";
import { jsonError, readJson, requireViewer } from "@/server/http";
import { rateLimit, clientIp } from "@/server/rate-limit";
import { assertHuman } from "@/server/bot";
import { checkIntegrationTargets, getSandboxService } from "@/server/sandbox-service";

const tooMany = (retryAfter: number) =>
  Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });

export async function POST(req: Request) {
  const blocked = await assertHuman(); if (blocked) return blocked;
  const ipLimit = await rateLimit(`sandbox-drafts:${clientIp(req)}`, 20, 600);
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfter);
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const userLimit = await rateLimit(`sandbox-drafts-user:${auth.viewer.id}`, 30, 3600);
  if (!userLimit.ok) return tooMany(userLimit.retryAfter);
  const body = await readJson(req, SandboxIntakeInput);
  if (!body.ok) return body.res;
  try {
    const rejected = await checkIntegrationTargets(body.data.integration);
    if (rejected) return jsonError(422, `Target URL rejected: ${rejected.reason}`, { field: `integration.${rejected.field}` });
    const draft = await getSandboxService().createDraft(auth.viewer.id, body.data);
    return Response.json({ draft }, { status: 201 });
  } catch (err) {
    console.error("create sandbox draft failed", err);
    return jsonError(500, "Could not create draft");
  }
}
