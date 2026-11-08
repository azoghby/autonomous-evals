import "server-only";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { oauthClients, oauthCodes, oauthTokens } from "@ae/core/db/oauth-schema";
import type { CodeRecord, GrantSummary, OAuthClientRecord, OAuthStore, TokenRecord } from "./core";

const LAST_USED_THROTTLE_MS = 60_000;

/** Postgres implementation. Claims are single conditional UPDATEs, so concurrent replays get one winner. */
export class DbOAuthStore implements OAuthStore {
  async insertClient(c: OAuthClientRecord): Promise<void> {
    await db().insert(oauthClients).values(c);
  }

  async getClient(id: string): Promise<OAuthClientRecord | null> {
    if (id.length > 100) return null;
    const [row] = await db().select().from(oauthClients).where(eq(oauthClients.id, id)).limit(1);
    return row ? { ...row, tokenEndpointAuthMethod: row.tokenEndpointAuthMethod as OAuthClientRecord["tokenEndpointAuthMethod"] } : null;
  }

  async insertCode(c: CodeRecord): Promise<void> {
    await db().insert(oauthCodes).values(c);
  }

  async claimCode(codeHash: string, now: Date) {
    const claimed = await db().update(oauthCodes).set({ usedAt: now })
      .where(and(eq(oauthCodes.codeHash, codeHash), isNull(oauthCodes.usedAt)))
      .returning();
    if (claimed[0]) return { row: claimed[0] };
    const [existing] = await db().select().from(oauthCodes).where(eq(oauthCodes.codeHash, codeHash)).limit(1);
    return existing ? { reused: existing } : null;
  }

  async insertTokens(ts: TokenRecord[]): Promise<void> {
    await db().insert(oauthTokens).values(ts);
  }

  async findToken(tokenHash: string) {
    const [row] = await db().select({
      tokenHash: oauthTokens.tokenHash, kind: oauthTokens.kind, grantId: oauthTokens.grantId, clientId: oauthTokens.clientId,
      customerId: oauthTokens.customerId, scope: oauthTokens.scope, resource: oauthTokens.resource,
      expiresAt: oauthTokens.expiresAt, revokedAt: oauthTokens.revokedAt, email: schema.customers.email,
    }).from(oauthTokens)
      .innerJoin(schema.customers, eq(schema.customers.id, oauthTokens.customerId))
      .where(and(eq(oauthTokens.tokenHash, tokenHash), isNull(oauthTokens.revokedAt)))
      .limit(1);
    return row ? { ...row, kind: row.kind as TokenRecord["kind"] } : null;
  }

  async claimRefresh(tokenHash: string, now: Date) {
    const claimed = await db().update(oauthTokens).set({ revokedAt: now })
      .where(and(eq(oauthTokens.tokenHash, tokenHash), eq(oauthTokens.kind, "refresh"), isNull(oauthTokens.revokedAt)))
      .returning();
    if (claimed[0]) return { row: { ...claimed[0], kind: "refresh" as const } };
    const [existing] = await db().select().from(oauthTokens)
      .where(and(eq(oauthTokens.tokenHash, tokenHash), eq(oauthTokens.kind, "refresh"))).limit(1);
    return existing ? { reused: { ...existing, kind: "refresh" as const } } : null;
  }

  async revokeToken(tokenHash: string, now: Date) {
    const [row] = await db().update(oauthTokens).set({ revokedAt: now })
      .where(and(eq(oauthTokens.tokenHash, tokenHash), isNull(oauthTokens.revokedAt))).returning();
    return row ? { ...row, kind: row.kind as TokenRecord["kind"] } : null;
  }

  async revokeGrant(grantId: string, now: Date, customerId?: string): Promise<number> {
    const rows = await db().update(oauthTokens).set({ revokedAt: now })
      .where(and(
        eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt),
        ...(customerId ? [eq(oauthTokens.customerId, customerId)] : []),
      )).returning({ id: oauthTokens.id });
    return rows.length;
  }

  async listGrants(customerId: string): Promise<GrantSummary[]> {
    return db().select({
      grantId: oauthTokens.grantId, clientId: oauthTokens.clientId, clientName: oauthClients.clientName,
      scope: oauthTokens.scope, createdAt: oauthTokens.createdAt, lastUsedAt: oauthTokens.lastUsedAt,
    }).from(oauthTokens)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthTokens.clientId))
      .where(and(eq(oauthTokens.customerId, customerId), eq(oauthTokens.kind, "refresh"), isNull(oauthTokens.revokedAt), gt(oauthTokens.expiresAt, sql`now()`)))
      .orderBy(desc(oauthTokens.createdAt));
  }

  async touchToken(tokenHash: string, now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - LAST_USED_THROTTLE_MS);
    await db().update(oauthTokens).set({ lastUsedAt: now })
      .where(and(eq(oauthTokens.tokenHash, tokenHash), sql`(${oauthTokens.lastUsedAt} is null or ${oauthTokens.lastUsedAt} < ${cutoff})`));
  }
}
