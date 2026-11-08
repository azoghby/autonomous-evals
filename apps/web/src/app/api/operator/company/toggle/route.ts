import { z } from "zod";
import { db, schema } from "@ae/core/db/client";
import { CompanyAgentIdSchema } from "@ae/core/company/registry";
import { jsonError, readJson, requireOperator } from "@/server/http";
import { setAgentToggle } from "@/server/company/store";

export const dynamic = "force-dynamic";

const Body = z.object({ agentId: CompanyAgentIdSchema, enabled: z.boolean() });

export async function POST(req: Request) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const body = await readJson(req, Body);
  if (!body.ok) return body.res;
  const { agentId, enabled } = body.data;
  try {
    await setAgentToggle(agentId, enabled, auth.viewer.email);
    await db().insert(schema.interventions).values({
      jobId: null, operatorEmail: auth.viewer.email, kind: "other", note: `Company agent ${agentId} switched ${enabled ? "on" : "off"}`,
    });
  } catch (err) {
    console.error("company toggle failed", err instanceof Error ? err.message : err);
    return jsonError(500, "Could not update toggle");
  }
  return Response.json({ agentId, enabled });
}
