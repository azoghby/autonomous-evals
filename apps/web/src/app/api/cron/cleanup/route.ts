import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { requireCronAuth } from "../_auth";
import { getEvalServices } from "../../../../server/services";

export const dynamic = "force-dynamic";

/** Enforces the two independent deadlines: credentials (delivery + 24h) and Neon branch (delivery + 48h). */
export async function GET(request: Request) {
  const denied = requireCronAuth(request);
  if (denied) return denied;
  const now = new Date();
  const errors: string[] = [];

  const expiredCreds = db().select({ id: schema.jobs.id }).from(schema.jobs)
    .where(and(isNotNull(schema.jobs.credentialsDeleteAfter), lt(schema.jobs.credentialsDeleteAfter, now)));
  const deleted = await db().delete(schema.jobCredentials)
    .where(inArray(schema.jobCredentials.jobId, expiredCreds)).returning({ id: schema.jobCredentials.jobId });

  let branchesDeleted = 0;
  const due = await db().select({ id: schema.jobs.id, branch: schema.jobs.neonBranchId }).from(schema.jobs)
    .where(and(isNotNull(schema.jobs.neonBranchId), isNotNull(schema.jobs.branchDeleteAfter), lt(schema.jobs.branchDeleteAfter, now)));
  if (due.length > 0) {
    const services = await getEvalServices();
    for (const j of due) {
      try {
        await services.deleteJobBranch(j.branch!);
        await db().update(schema.jobs).set({ neonBranchId: null }).where(eq(schema.jobs.id, j.id));
        branchesDeleted++;
      } catch (err) {
        errors.push(`${j.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return Response.json({ credentialsDeleted: deleted.length, branchesDeleted, errors }, { status: errors.length ? 500 : 200 });
}
