import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { hashToken } from "@ae/core/auth/tokens";
import { generateShareToken, isPlausibleShareToken, redactReport, type RedactedReport } from "./share-core";

/** Create (or rotate) the share link for a job. The plaintext token is only available in this return value. */
export async function enableShare(jobId: string): Promise<{ token: string; createdAt: Date }> {
  const { token, tokenHash } = generateShareToken();
  const now = new Date();
  await db().insert(schema.jobShares)
    .values({ jobId, tokenHash, createdAt: now, revokedAt: null })
    .onConflictDoUpdate({ target: schema.jobShares.jobId, set: { tokenHash, createdAt: now, revokedAt: null } });
  return { token, createdAt: now };
}

export async function revokeShare(jobId: string): Promise<boolean> {
  const rows = await db().update(schema.jobShares).set({ revokedAt: new Date() })
    .where(and(eq(schema.jobShares.jobId, jobId), isNull(schema.jobShares.revokedAt)))
    .returning({ id: schema.jobShares.id });
  return rows.length > 0;
}

export async function getShareStatus(jobId: string): Promise<{ enabled: boolean; createdAt: Date | null }> {
  const [row] = await db().select().from(schema.jobShares).where(eq(schema.jobShares.jobId, jobId)).limit(1);
  return { enabled: !!row && !row.revokedAt, createdAt: row?.createdAt ?? null };
}

/** Public lookup by plaintext token. Null for unknown, revoked, undelivered. Returns only the redacted view. */
export async function loadSharedReport(token: string): Promise<RedactedReport | null> {
  if (!isPlausibleShareToken(token)) return null;
  const [share] = await db().select().from(schema.jobShares)
    .where(and(eq(schema.jobShares.tokenHash, hashToken(token)), isNull(schema.jobShares.revokedAt))).limit(1);
  if (!share) return null;
  const [job] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, share.jobId)).limit(1);
  if (!job || job.state !== "delivered") return null;
  const [findings, remediations] = await Promise.all([
    db().select({ id: schema.findings.id, data: schema.findings.data }).from(schema.findings).where(eq(schema.findings.jobId, job.id)),
    db().select({ findingRowId: schema.remediations.findingRowId, data: schema.remediations.data }).from(schema.remediations).where(eq(schema.remediations.jobId, job.id)),
  ]);
  return redactReport(
    { package: job.package, deliveredAt: job.deliveredAt, isMock: job.isMock, environment: job.environment },
    findings, remediations,
  );
}
