/**
 * MCP OAuth 2.1 tables (authorization server for /api/mcp/mcp).
 * Kept out of schema.ts on purpose: the orchestrator merges these into schema.ts and generates the
 * migration. Every secret (client secret, code, access/refresh token) is stored as a sha256 hash only.
 */
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { customers } from "./schema";

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** RFC 7591 dynamically registered clients. Public clients (token_endpoint_auth_method "none") have no secret. */
export const oauthClients = pgTable("oauth_clients", {
  /** Public client_id, e.g. "aeoc_…". */
  id: text("id").primaryKey(),
  clientName: text("client_name").notNull(),
  clientUri: text("client_uri"),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  grantTypes: jsonb("grant_types").$type<string[]>().notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull(), // none | client_secret_post | client_secret_basic
  clientSecretHash: text("client_secret_hash"),
  scope: text("scope").notNull(),
  softwareId: text("software_id"),
  softwareVersion: text("software_version"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Authorization codes: single-use, 60 s TTL, PKCE S256 challenge bound. */
export const oauthCodes = pgTable("oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  /** Every token minted from this code (and its refreshes) shares this id, so a replayed code revokes them all. */
  grantId: uuid("grant_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  scope: text("scope").notNull(),
  resource: text("resource"),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("oauth_codes_expires_idx").on(t.expiresAt)]);

/** Access + refresh tokens. Refresh tokens rotate; reuse of a rotated refresh token revokes the whole grant. */
export const oauthTokens = pgTable("oauth_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull(),
  kind: text("kind").notNull(), // access | refresh
  grantId: uuid("grant_id").notNull(),
  clientId: text("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  scope: text("scope").notNull(),
  resource: text("resource"),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  lastUsedAt: ts("last_used_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("oauth_tokens_hash_uq").on(t.tokenHash),
  index("oauth_tokens_grant_idx").on(t.grantId),
  index("oauth_tokens_customer_idx").on(t.customerId).where(sql`${t.revokedAt} is null`),
]);
