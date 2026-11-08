import { z } from "zod";
import { db, schema } from "@ae/core/db/client";
import { CompanyAgentIdSchema } from "@ae/core/company/registry";
import { jsonError, readJson, requireOperator } from "@/server/http";
import { runAgentById } from "@/server/company/agents";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({ agentId: CompanyAgentIdSchema, dryRun: z.boolean().optional() });

/** Operator "Run now". Respects the agent's toggle and every budget cap (it never bypasses runCompanyAgent). */
export async function POST(req: Request) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const body = await readJson(req, Body);
  if (!body.ok) return body.res;
  const { agentId, dryRun } = body.data;
  try {
    await db().insert(schema.interventions).values({
      jobId: null, operatorEmail: auth.viewer.email, kind: "other", note: `Ran company agent ${agentId} manually${dryRun ? " (dry run)" : ""}`,
    });
    const result = await runAgentById(agentId, { trigger: "manual", dryRun });
    return Response.json(result);
  } catch (err) {
    console.error("company run failed", err instanceof Error ? err.message : err);
    return jsonError(500, "Agent run failed");
  }
}
