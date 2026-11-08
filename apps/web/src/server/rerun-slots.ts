import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";

export const MAX_RERUNS_PER_FINDING = 3;
const slotKey = (originalId: string, n: number) => `rerun-slot:${originalId}:${n}`;

/**
 * Atomically claims one of the N re-run slots for a finding. Each slot is a single INSERT ... ON CONFLICT
 * DO NOTHING on the idempotency_keys primary key, so concurrent requests can never claim the same slot and
 * at most MAX_RERUNS_PER_FINDING claims exist (Neon HTTP has no interactive transactions).
 * Returns the claimed key, or null when the limit is reached.
 */
export async function claimRerunSlot(originalId: string, max = MAX_RERUNS_PER_FINDING): Promise<string | null> {
  for (let n = 1; n <= max; n++) {
    const key = slotKey(originalId, n);
    const got = await db().insert(schema.idempotencyKeys)
      .values({ key, scope: "rerun-slot" }).onConflictDoNothing().returning({ key: schema.idempotencyKeys.key });
    if (got.length > 0) return key;
  }
  return null;
}

/** Give the slot back when the re-run failed so the customer can retry. */
export async function releaseRerunSlot(key: string): Promise<void> {
  await db().delete(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, key));
}
