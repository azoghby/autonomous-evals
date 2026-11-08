/**
 * One-off user-feedback campaign (founder-authorized, Nov 8). Sends ONE plain-text invite per vetted recipient through
 * the app's AgentMail sender (sendCompanyEmail: suppression check + dry-run guard), records each in feedback_invites,
 * and appends to <out>/sent.json. Default is a dry run that writes rendered previews and touches nothing.
 *
 *   cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx --tsconfig tsconfig.json \
 *     ../../scripts/feedback-outreach.ts --recipients <recipients.json> --out <dir> [--send]
 *
 * recipients.json: [{ email, name|null, org, reason, sourceUrl }]. Only addresses the person/company publishes
 * themselves, with the page they publish it on. Hard cap FEEDBACK_SEND_CAP (25) across all runs; no follow-ups.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [resolve(ROOT, "apps/web/.env.local"), resolve(ROOT, ".env")]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const SPACING_MS = 5_000;
const APP_URL = "https://standard-evals.vercel.app";

const recipientSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  name: z.string().trim().min(1).nullable(),
  org: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(20).max(260),
  sourceUrl: z.url().refine((u) => u.startsWith("https://"), "sourceUrl must be https"),
});

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const mask = (e: string) => e.replace(/^(.).*(@.*)$/, "$1***$2");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

async function main(): Promise<void> {
  const send = process.argv.includes("--send");
  const recipientsPath = arg("--recipients");
  const out = arg("--out");
  if (!recipientsPath || !out) throw new Error("usage: --recipients <file.json> --out <dir> [--send]");
  const { FEEDBACK_SEND_CAP, FEEDBACK_EMAIL_MAX_WORDS, FOUNDER_REPLY_TO, buildFeedbackEmail, feedbackBodyWords } = await import("@/server/feedback-logic");
  const recipients = z.array(recipientSchema).parse(JSON.parse(readFileSync(recipientsPath, "utf8")));
  if (recipients.length > FEEDBACK_SEND_CAP) throw new Error(`${recipients.length} recipients exceeds the cap of ${FEEDBACK_SEND_CAP}`);
  if (new Set(recipients.map((r) => r.email)).size !== recipients.length) throw new Error("duplicate recipient email");

  const { db, schema } = await import("@ae/core/db/client");
  const { eq, isNotNull, sql } = await import("drizzle-orm");
  const { isSuppressed, companyAddress } = await import("@/server/owner-shared");
  const { sendCompanyEmail } = await import("@/server/company/mailer");
  const I = schema.feedbackInvites;
  const address = process.env.COMPANY_ADDRESS ? companyAddress() : null;

  // A dry run works before migration 0029 is applied: missing feedback_invites reads as "nothing sent yet".
  const tolerant = <T,>(p: Promise<T>, fallback: T): Promise<T> => (send ? p : p.catch(() => fallback));
  const [sentRow] = await tolerant(db().select({ n: sql<number>`count(*)` }).from(I).where(isNotNull(I.sentAt)), [{ n: 0 }]);
  let budget = FEEDBACK_SEND_CAP - Number(sentRow?.n ?? 0);
  mkdirSync(resolve(out, "preview"), { recursive: true });
  const sentPath = resolve(out, "sent.json");
  const sentLog: unknown[] = existsSync(sentPath) ? JSON.parse(readFileSync(sentPath, "utf8")) : [];
  process.stdout.write(`${send ? "SEND" : "DRY RUN"}: ${recipients.length} recipients, ${budget} sends left under the cap, app ${APP_URL}\n`);

  for (const [n, r] of recipients.entries()) {
    const tag = `${String(n + 1).padStart(2, "0")} ${r.org}`;
    const [existing] = await tolerant(db().select().from(I).where(sql`lower(${I.email}) = ${r.email}`).limit(1), []);
    if (existing?.sentAt) { process.stdout.write(`${tag}: skip, already sent ${existing.sentAt.toISOString()}\n`); continue; }
    if (await isSuppressed(r.email)) {
      process.stdout.write(`${tag}: skip, suppressed\n`);
      if (send && existing) await db().update(I).set({ status: "suppressed" }).where(eq(I.id, existing.id));
      continue;
    }
    const token = existing?.token ?? (send ? randomBytes(18).toString("base64url") : `dryrun-${slug(r.org)}`);
    const email = buildFeedbackEmail(r, { appUrl: APP_URL, token, companyAddress: address });
    if (/localhost|127\.0\.0\.1/i.test(`${email.subject}\n${email.text}`)) throw new Error(`${tag}: refusing, body contains a localhost link`);
    const words = feedbackBodyWords(email.text);
    if (words > FEEDBACK_EMAIL_MAX_WORDS) throw new Error(`${tag}: body is ${words} words (max ${FEEDBACK_EMAIL_MAX_WORDS})`);
    writeFileSync(resolve(out, "preview", `${String(n + 1).padStart(2, "0")}-${slug(r.org)}.txt`),
      `To: ${r.email}\nReply-To: ${FOUNDER_REPLY_TO}\nSubject: ${email.subject}\nSource: ${r.sourceUrl}\nWords: ${words}\n\n${email.text}\n`);
    if (!send) { process.stdout.write(`${tag}: ${mask(r.email)} rendered (${words} words)\n`); continue; }
    if (budget <= 0) { process.stdout.write(`${tag}: stop, cap of ${FEEDBACK_SEND_CAP} reached\n`); break; }

    const invite = existing ?? (await db().insert(I).values({ token, email: r.email, name: r.name, org: r.org, sourceUrl: r.sourceUrl }).returning())[0]!;
    try {
      const res = await sendCompanyEmail(
        { to: r.email, subject: email.subject, text: email.text, headers: email.headers, replyTo: FOUNDER_REPLY_TO, labels: ["feedback_invite"] },
        { dryRun: false },
      );
      if (res.status !== "sent") {
        await db().update(I).set({ status: res.status === "suppressed" ? "suppressed" : "pending" }).where(eq(I.id, invite.id));
        process.stdout.write(`${tag}: not sent (${res.status})\n`);
        continue;
      }
      const sentAt = new Date();
      await db().update(I).set({ status: "sent", messageId: res.sent.id, threadId: res.sent.threadId ?? null, sentAt }).where(eq(I.id, invite.id));
      budget--;
      const rec = { sentAt: sentAt.toISOString(), recipient: r.email, name: r.name, org: r.org, sourceUrl: r.sourceUrl, messageId: res.sent.id, threadId: res.sent.threadId ?? null, inviteId: invite.id };
      sentLog.push(rec);
      writeFileSync(sentPath, `${JSON.stringify(sentLog, null, 2)}\n`);
      process.stdout.write(`${tag}: sent ${mask(r.email)} message ${res.sent.id}\n`);
    } catch (err) {
      await db().update(I).set({ status: "failed" }).where(eq(I.id, invite.id));
      appendFileSync(resolve(out, "errors.log"), `${new Date().toISOString()} ${r.org}: ${err instanceof Error ? err.message : String(err)}\n`);
      process.stdout.write(`${tag}: FAILED (see errors.log)\n`);
    }
    await sleep(SPACING_MS);
  }
}

main().then(() => process.exit(0)).catch((e) => { process.stdout.write(`failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
