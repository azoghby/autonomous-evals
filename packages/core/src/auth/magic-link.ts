import { and, eq, isNull, gt, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { sendEmail } from "./email";
import {
  MAGIC_LINK_TTL_MS, SESSION_TTL_MS, hashToken, newToken, normalizeEmail, checkMagicLink,
} from "./tokens";

export { isOperator } from "./tokens";

const devLinksEnabled = () =>
  process.env.AUTH_DEV_LINKS === "1" || (!process.env.RESEND_API_KEY && process.env.NODE_ENV !== "production");

function appOrigin(): string {
  return process.env.APP_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");
}

export async function requestMagicLink(rawEmail: string, next?: string): Promise<{ devLink?: string }> {
  const email = normalizeEmail(rawEmail);
  const token = newToken();
  await db().insert(schema.magicLinks).values({
    email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
  });
  const qs = new URLSearchParams({ token });
  if (next) qs.set("next", next);
  const link = `${appOrigin()}/api/auth/verify?${qs}`;
  if (devLinksEnabled()) return { devLink: link };
  await sendEmail({
    to: email,
    subject: "Your sign-in link",
    text: `Sign in to Autonomous Evals: ${link}\n\nThis link expires in 15 minutes and works once.`,
  });
  return {};
}

export type VerifyResult =
  | { ok: true; sessionToken: string; expiresAt: Date; customerId: string; email: string }
  | { ok: false; reason: "invalid" | "used" | "expired" };

export async function verifyMagicLink(token: string): Promise<VerifyResult> {
  const hash = hashToken(token);
  const [row] = await db().select().from(schema.magicLinks).where(eq(schema.magicLinks.tokenHash, hash)).limit(1);
  if (!row) return { ok: false, reason: "invalid" };
  const check = checkMagicLink(row);
  if (check !== "ok") return { ok: false, reason: check };

  // Atomic single-use claim: only one concurrent verifier gets the row back.
  const claimed = await db().update(schema.magicLinks)
    .set({ usedAt: new Date() })
    .where(and(eq(schema.magicLinks.id, row.id), isNull(schema.magicLinks.usedAt), gt(schema.magicLinks.expiresAt, new Date())))
    .returning({ id: schema.magicLinks.id });
  if (claimed.length === 0) return { ok: false, reason: "used" };

  const email = normalizeEmail(row.email);
  await db().insert(schema.customers).values({ email }).onConflictDoNothing();
  const [customer] = await db().select().from(schema.customers).where(sql`lower(${schema.customers.email}) = ${email}`).limit(1);
  if (!customer) throw new Error("Customer upsert failed");

  const sessionToken = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db().insert(schema.sessions).values({ customerId: customer.id, tokenHash: hashToken(sessionToken), expiresAt });
  return { ok: true, sessionToken, expiresAt, customerId: customer.id, email };
}

export async function customerForSessionToken(token: string) {
  const [row] = await db()
    .select({ id: schema.customers.id, email: schema.customers.email })
    .from(schema.sessions)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.sessions.customerId))
    .where(and(eq(schema.sessions.tokenHash, hashToken(token)), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function destroySession(token: string): Promise<void> {
  await db().delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token)));
}
