import { z } from "zod";
import { requestMagicLink } from "@ae/core/auth/magic-link";
import { jsonError, readJson } from "@/server/http";

const Body = z.object({ email: z.email().max(320), next: z.string().max(500).optional() });

export async function POST(req: Request) {
  const body = await readJson(req, Body);
  if (!body.ok) return body.res;
  try {
    const { devLink } = await requestMagicLink(body.data.email, body.data.next);
    return Response.json({ ok: true, ...(devLink ? { devLink } : {}) });
  } catch (err) {
    console.error("request-link failed", err);
    return jsonError(500, "Could not send sign-in link");
  }
}
