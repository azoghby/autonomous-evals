import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import type { Environment, IntakeInput } from "@ae/core/contracts/index";
import { encryptJson } from "@ae/core/storage/crypto";
import { putJobArtifact } from "@ae/core/storage/blob";
import { startJobWorkflow } from "@/workflows/events";
import { extractLargeTrace, stripCredentials, type CredentialMap } from "./intake";
import { isMockServices } from "./services";
import { expertOwnerDatabase } from './automated-expert-owner';
import { insertNewFactualJob, readNewJobFactualGapEnabled } from './naive-new-job';

export const currentEnvironment = (): Environment => (process.env.STRIPE_MODE === "live" ? "live" : "test");

interface CreateJobArgs {
  customerId: string;
  idempotencyKey: string;
  /** Either a fresh intake (keys inline) or a pre-split copy for retests. */
  intake?: IntakeInput;
  prepared?: { sanitized: Record<string, unknown>; credentials: CredentialMap; traceBlobPath: string | null };
  retestOfJobId?: string;
}

/** Inserts the job, credentials, starts the workflow. Safe to call again with the same key (re-attempts the start). */
export async function createJob(args: CreateJobArgs): Promise<{ jobId: string }> {
  const [existing] = await db().select({ id: schema.jobs.id }).from(schema.jobs)
    .where(and(eq(schema.jobs.customerId, args.customerId), eq(schema.jobs.idempotencyKey, args.idempotencyKey))).limit(1);

  let jobId = existing?.id;
  if (!jobId) {
    jobId = randomUUID();
    let sanitized: Record<string, unknown>, credentials: CredentialMap, traceBlobPath: string | null;
    if (args.prepared) {
      ({ sanitized, credentials, traceBlobPath } = args.prepared);
    } else {
      const stripped = stripCredentials(args.intake!);
      const split = extractLargeTrace(stripped.sanitized);
      sanitized = split.intake; credentials = stripped.credentials;
      traceBlobPath = split.trace ? await putJobArtifact(jobId, "trace", split.trace, "text/plain") : null;
    }
    const pkg = (sanitized.package as IntakeInput["package"]);
    const isMock = isMockServices();
    if (readNewJobFactualGapEnabled({ package: pkg, isMock })) {
      jobId = await insertNewFactualJob(expertOwnerDatabase(), {
        jobId, customerId: args.customerId, environment: currentEnvironment(),
        idempotencyKey: args.idempotencyKey, intake: sanitized, traceBlobPath,
        retestOfJobId: args.retestOfJobId,
        ciphertext: Object.keys(credentials).length > 0 ? encryptJson(credentials) : null,
      });
    } else {
    await db().insert(schema.jobs).values({
      id: jobId, customerId: args.customerId, package: pkg, state: "draft", environment: currentEnvironment(),
      intake: sanitized, traceBlobPath, isMock, idempotencyKey: args.idempotencyKey,
      retestOfJobId: args.retestOfJobId ?? null,
    });
    if (Object.keys(credentials).length > 0) {
      await db().insert(schema.jobCredentials).values({ jobId, ciphertext: encryptJson(credentials) });
    }
    }
  }
  const { runId } = await startJobWorkflow(jobId);
  if (runId) await db().update(schema.jobs).set({ workflowRunId: runId }).where(eq(schema.jobs.id, jobId));
  return { jobId };
}
