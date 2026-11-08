import { z } from "zod";
import { db, schema } from "@ae/core/db/client";
import { jsonError, readJson, requireOperator } from "@/server/http";

const Body = z.object({
  jobId: z.uuid().optional(),
  kind: z.enum(["refund", "override", "fix", "approve_outreach", "other"]),
  note: z.string().trim().min(1).max(5_000),
});

export async function POST(req: Request) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const body = await readJson(req, Body);
  if (!body.ok) return body.res;
  const [row] = await db().insert(schema.interventions).values({
    jobId: body.data.jobId ?? null, operatorEmail: auth.viewer.email, kind: body.data.kind, note: body.data.note,
  }).returning();
  return Response.json({ intervention: row }, { status: 201 });
}
