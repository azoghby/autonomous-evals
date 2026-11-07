import "server-only";
import { and, count, desc, eq, isNull, lt, or } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { hashToken } from "@ae/core/auth/tokens";
import { generateKeyString, keyDisplayPrefix, parseKeyFormat } from "./api-key-format";

const MAX_ACTIVE_KEYS = 20;
const LAST_USED_THROTTLE_MS = 60_000;

export async function createApiKey(customerId: string, name: string): Promise<{ id: string; prefix: string; key: string }> {
  const [{ n }] = await db().select({ n: count() }).from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.customerId, customerId), isNull(schema.apiKeys.revokedAt)));
  if (n >= MAX_ACTIVE_KEYS) throw new Error(`API key limit reached (${MAX_ACTIVE_KEYS} active keys). Revoke an existing key first.`);
  const key = generateKeyString(process.env.STRIPE_MODE === "live");
  const prefix = keyDisplayPrefix(key);
  const [row] = await db().insert(schema.apiKeys)
    .values({ customerId, name, keyHash: hashToken(key), prefix })
    .returning({ id: schema.apiKeys.id });
  return { id: row.id, prefix, key };
}

export async function verifyApiKey(bearer: string | undefined): Promise<{ keyId: string; customerId: string; email: string } | null> {
  if (!bearer || !parseKeyFormat(bearer)) return null;
  const [row] = await db().select({
    keyId: schema.apiKeys.id,
    customerId: schema.apiKeys.customerId,
    email: schema.customers.email,
    lastUsedAt: schema.apiKeys.lastUsedAt,
    revokedAt: schema.apiKeys.revokedAt,
  }).from(schema.apiKeys)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.apiKeys.customerId))
    .where(eq(schema.apiKeys.keyHash, hashToken(bearer)))
    .limit(1);
  if (!row || row.revokedAt) return null;
  const now = Date.now();
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    const cutoff = new Date(now - LAST_USED_THROTTLE_MS);
    void db().update(schema.apiKeys).set({ lastUsedAt: new Date(now) })
      .where(and(eq(schema.apiKeys.id, row.keyId), or(isNull(schema.apiKeys.lastUsedAt), lt(schema.apiKeys.lastUsedAt, cutoff))))
      .then(() => undefined, (err) => console.error("api key lastUsedAt update failed", err));
  }
  return { keyId: row.keyId, customerId: row.customerId, email: row.email };
}

export async function revokeApiKey(customerId: string, keyId: string): Promise<boolean> {
  const rows = await db().update(schema.apiKeys).set({ revokedAt: new Date() })
    .where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.customerId, customerId), isNull(schema.apiKeys.revokedAt)))
    .returning({ id: schema.apiKeys.id });
  return rows.length > 0;
}

export async function listApiKeys(customerId: string): Promise<Array<{
  id: string; name: string; prefix: string; lastUsedAt: Date | null; revokedAt: Date | null; createdAt: Date;
}>> {
  return db().select({
    id: schema.apiKeys.id, name: schema.apiKeys.name, prefix: schema.apiKeys.prefix,
    lastUsedAt: schema.apiKeys.lastUsedAt, revokedAt: schema.apiKeys.revokedAt, createdAt: schema.apiKeys.createdAt,
  }).from(schema.apiKeys)
    .where(eq(schema.apiKeys.customerId, customerId))
    .orderBy(desc(schema.apiKeys.createdAt));
}
