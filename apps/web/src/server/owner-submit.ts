import "server-only";
/**
 * Agent-owner autopilot: owner submission (pending until the mailbox is proven) and verification.
 * The consent record + verified email become the authorization that assertAuthorizedToTest requires.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@ae/core/db/client";
import { sendEmail } from "@ae/core/auth/email";
import { encrypt } from "@ae/core/storage/crypto";
import { hashToken, maskEmail, newToken, normalizeEmail } from "@ae/core/auth/tokens";
import { assertAuthorizedToTest } from "./leaderboard-agents";
import { SLUG_RE } from "./leaderboard";
import {
  CONSENT_AUTHORIZE_TEXT, CONSENT_EMAILS_TEXT, CONSENT_VERSION, OWNER_KEY_SENTINEL, OWNER_TERMS_URL, VISIBILITIES,
  ipHash, type ConsentRecord, type Visibility,
} from "./owner-policy";
import { appUrl, footerFor, recordOwnerEmail } from "./owner-shared";

export const VERIFY_TTL_MS = 48 * 60 * 60 * 1000;

export const SubmitAgentInput = z.object({
  ownerEmail: z.string().trim().max(254).pipe(z.email()),
  agentName: z.string().trim().min(1).max(120),
  org: z.string().trim().min(1).max(120),
  /** Full OpenAI-compatible chat completions URL. HTTPS only. */
  endpointUrl: z.url().refine((u) => u.startsWith("https://"), "endpointUrl must use HTTPS"),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().max(500).optional(),
  systemPrompt: z.string().max(20_000).optional(),
  visibility: z.enum(VISIBILITIES),
  consentAuthorize: z.literal(true),
  consentEmails: z.literal(true),
  hp: z.string().optional(),
});
export type SubmitAgentInput = z.infer<typeof SubmitAgentInput>;

const BASE36 = "abcdefghijklmnopqrstuvwxyz0123456789";
export function makeSlug(name: string): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "agent";
  const bytes = randomBytes(6);
  const suffix = Array.from(bytes, (b) => BASE36[b % 36]).join("");
  const slug = `${base}-${suffix}`;
  if (!SLUG_RE.test(slug)) throw new Error("generated slug is invalid");
  return slug;
}

export function buildVerifyEmail(i: { agentName: string; email: string; link: string }): { subject: string; text: string } {
  const text = [
    `Hi,`,
    ``,
    `Someone (hopefully you) submitted "${i.agentName}" to be tested on the Standard Evals leaderboard using this email address. This message was written and sent by Standard Evals' AI agents; the company is run by human founders.`,
    ``,
    `Nothing happens until you confirm. To confirm, open this link and press the Confirm button (valid for 48 hours):`,
    i.link,
    ``,
    `After you confirm:`,
    `- Our agents run a red-team suite and the standard test suite against your agent automatically.`,
    `- We email you the results.`,
    `- Runs repeat weekly. You hear from us again only when something meaningful changes.`,
    `- Reply to this email any time to pause runs, make results private, or opt out.`,
    ``,
    `You agreed to:`,
    `- ${CONSENT_AUTHORIZE_TEXT}`,
    `- ${CONSENT_EMAILS_TEXT}`,
    ``,
    `If you did not submit this, ignore this email and nothing will run.`,
  ].join("\n");
  return { subject: `Confirm testing of "${i.agentName}"`, text: `${text}\n\n${footerFor(i.agentName, i.email)}` };
}

export interface PendingResult { agentId: string; slug: string; emailSent: boolean }

/** Stores a pending (inactive, unauthorized) agent + hashed verify token, then emails the link. */
export async function createPendingSubmission(input: SubmitAgentInput, ctx: { ip: string; now?: Date }): Promise<PendingResult> {
  const now = ctx.now ?? new Date();
  const email = normalizeEmail(input.ownerEmail);
  const id = randomUUID();
  const slug = makeSlug(input.agentName);
  const token = newToken();
  const consent: ConsentRecord = {
    version: CONSENT_VERSION, authorizeText: CONSENT_AUTHORIZE_TEXT, emailsText: CONSENT_EMAILS_TEXT,
    acceptedAt: now.toISOString(), ipHash: ipHash(ctx.ip),
  };
  const apiKey = input.apiKey?.trim();
  await db().batch([
    db().insert(schema.publicAgents).values({
      id, slug, name: input.agentName, vendor: input.org, kind: "third_party", endpointUrl: input.endpointUrl, model: input.model,
      systemPrompt: input.systemPrompt?.trim() || null, ownerEmail: email, visibility: input.visibility,
      status: "pending_verification", active: false, termsUrl: null, authorizedNote: null,
      apiKeyCiphertext: apiKey ? encrypt(apiKey) : null, authEnvVar: apiKey ? OWNER_KEY_SENTINEL : null, consent,
    }),
    db().insert(schema.publicAgentTokens).values({
      agentId: id, purpose: "verify", tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + VERIFY_TTL_MS),
    }),
  ]);
  const { subject, text } = buildVerifyEmail({ agentName: input.agentName, email, link: `${appUrl()}/leaderboard/verify/${token}` });
  let emailSent = false;
  try {
    const sent = await sendEmail({ to: email, subject, text, purpose: "auth", labels: ["owner_agent", "owner_verify"] });
    emailSent = true;
    await recordOwnerEmail({ to: email, agentId: id, kind: "owner_verify", transactional: true, sent });
  } catch (err) {
    console.error("owner verify email failed", slug, err instanceof Error ? err.message : "unknown");
  }
  return { agentId: id, slug, emailSent };
}

export type VerifyResult =
  | { status: "ok"; slug: string; visibility: Visibility; name: string }
  | { status: "used" | "expired" | "invalid" };

/** Single-use claim of the token, then activation. A GET must never call this. */
export async function verifySubmission(token: string, now: Date = new Date()): Promise<VerifyResult> {
  if (typeof token !== "string" || token.length < 16 || token.length > 200) return { status: "invalid" };
  const tokenHash = hashToken(token);
  const t = schema.publicAgentTokens;
  const claimed = await db().update(t).set({ usedAt: now })
    .where(and(eq(t.tokenHash, tokenHash), isNull(t.usedAt), gt(t.expiresAt, now), eq(t.purpose, "verify")))
    .returning({ agentId: t.agentId });
  const agentId = claimed[0]?.agentId;
  if (!agentId) {
    const [row] = await db().select({ usedAt: t.usedAt, expiresAt: t.expiresAt }).from(t)
      .where(and(eq(t.tokenHash, tokenHash), eq(t.purpose, "verify"))).limit(1);
    if (!row) return { status: "invalid" };
    return { status: row.usedAt ? "used" : "expired" };
  }
  const a = schema.publicAgents;
  const [agent] = await db().select().from(a).where(eq(a.id, agentId)).limit(1);
  if (!agent || !agent.ownerEmail || agent.status !== "pending_verification") return { status: "invalid" };
  const consent = agent.consent as ConsentRecord | null;
  const authorizedNote = [
    `Owner-submitted by ${maskEmail(agent.ownerEmail)}`,
    `consent ${consent?.version ?? CONSENT_VERSION} accepted ${consent?.acceptedAt ?? "unknown"} (ip hash ${(consent?.ipHash ?? "").slice(0, 8)})`,
    `email verified ${now.toISOString()}`,
  ].join("; ").slice(0, 1000);
  const s = schema.contactSuppressions;
  const [updated] = await db().batch([
    db().update(a).set({ status: "active", active: true, verifiedAt: now, termsUrl: OWNER_TERMS_URL, authorizedNote })
      .where(and(eq(a.id, agentId), eq(a.status, "pending_verification"))).returning(),
    // Verifying proves mailbox control: a fresh, explicit opt-in clears any older suppression.
    db().delete(s).where(sql`lower(${s.email}) = ${agent.ownerEmail}`),
  ]);
  const row = (updated as Array<typeof agent>)[0];
  if (!row) return { status: "invalid" };
  assertAuthorizedToTest(row);
  return { status: "ok", slug: row.slug, visibility: row.visibility as Visibility, name: row.name };
}
