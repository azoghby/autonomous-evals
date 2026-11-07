import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";

export interface StoredResponse { status: number; body: unknown }

export class IdempotencyInProgressError extends Error {
  constructor() { super("A request with this Idempotency-Key is still in progress"); }
}

/**
 * Runs fn once per scopeKey (callers include customer id + route + client key). Repeats replay the
 * stored response. If fn throws, the key is released so the client can retry.
 */
export async function withIdempotency(
  scopeKey: string, fn: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  const scope = scopeKey.split(":").slice(0, 2).join(":");
  const claimed = await db().insert(schema.idempotencyKeys)
    .values({ key: scopeKey, scope }).onConflictDoNothing().returning({ key: schema.idempotencyKeys.key });
  if (claimed.length === 0) {
    const [row] = await db().select().from(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, scopeKey)).limit(1);
    const stored = row?.response as StoredResponse | null | undefined;
    if (stored) return { ...stored, replayed: true };
    throw new IdempotencyInProgressError();
  }
  try {
    const res = await fn();
    await db().update(schema.idempotencyKeys).set({ response: res }).where(eq(schema.idempotencyKeys.key, scopeKey));
    return { ...res, replayed: false };
  } catch (err) {
    await db().delete(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, scopeKey));
    throw err;
  }
}
