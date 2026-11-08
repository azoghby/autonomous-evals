/**
 * One-off user-feedback campaign (founder-authorized, Nov 8). Sends ONE plain-text invite per vetted recipient through
 * the app's AgentMail sender (sendCompanyEmail: suppression check), records each in feedback_invites, and appends to
 * <out>/sent.json. Default is a dry run that writes rendered previews and writes nothing to the DB.
 *
 *   cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx --tsconfig tsconfig.json \
 *     ../../scripts/feedback-outreach.ts --recipients <recipients.json> --out <dir> [--send]
 *
 * recipients.json: [{ email, name|null, org, reason, sourceUrl }]. Only addresses the person/company publishes
 * themselves, with the page they publish it on. Hard cap FEEDBACK_SEND_CAP (25) across all runs; no follow-ups.
 * Each row is claimed atomically (pending -> sending) before sending; 'sending'/'failed' rows are never retried
 * (see apps/web/src/server/feedback-send.ts). To deliberately resend a failed row, reset it by hand after checking
 * AgentMail for the message.
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

async function main(): Promise<void> {
  const send = process.argv.includes("--send");
  const recipientsPath = arg("--recipients");
  const out = arg("--out");
  if (!recipientsPath || !out) throw new Error("usage: --recipients <file.json> --out <dir> [--send]");
  const recipients = z.array(recipientSchema).parse(JSON.parse(readFileSync(recipientsPath, "utf8")));

  const { FEEDBACK_SEND_CAP } = await import("@/server/feedback-logic");
  const { runFeedbackOutreach } = await import("@/server/feedback-send");
  const { db, schema } = await import("@ae/core/db/client");
  const { and, eq, inArray, isNotNull, or, sql } = await import("drizzle-orm");
  const { isSuppressed, companyAddress } = await import("@/server/owner-shared");
  const { sendCompanyEmail, emailDryRun } = await import("@/server/company/mailer");
  if (send && emailDryRun(false)) throw new Error("--send but email is not configured (or COMPANY_EMAIL_DRY_RUN=1); refusing");
  const I = schema.feedbackInvites;
  const cols = { id: I.id, token: I.token, status: I.status, sentAt: I.sentAt };

  // A dry run is read-only and works before the table exists (reads fall back to "nothing sent yet").
  const tolerant = <T,>(p: Promise<T>, fallback: T): Promise<T> => (send ? p : p.catch(() => fallback));
  const writeGuard = () => { if (!send) throw new Error("dry run must not write to the DB"); };
  const findByEmail = async (email: string) => {
    const [r] = await tolerant(db().select(cols).from(I).where(sql`lower(${I.email}) = ${email.toLowerCase()}`).limit(1), []);
    return r ?? null;
  };

  mkdirSync(resolve(out, "preview"), { recursive: true });
  const sentPath = resolve(out, "sent.json");
  const sentLog: unknown[] = existsSync(sentPath) ? JSON.parse(readFileSync(sentPath, "utf8")) : [];
  const address = process.env.COMPANY_ADDRESS ? companyAddress() : null;

  const usedCount = async () => {
    const [row] = await tolerant(db().select({ n: sql<number>`count(*)` }).from(I)
      .where(or(inArray(I.status, ["sending", "sent", "failed", "replied"]), isNotNull(I.sentAt))), [{ n: 0 }]);
    return Number(row?.n ?? 0);
  };
  process.stdout.write(`${send ? "SEND" : "DRY RUN"}: ${recipients.length} recipients, ${FEEDBACK_SEND_CAP - (await usedCount())} sends left under the cap, app ${APP_URL}\n`);

  const summary = await runFeedbackOutreach(recipients, { send }, {
    appUrl: APP_URL,
    companyAddress: address,
    newToken: () => randomBytes(18).toString("base64url"),
    isSuppressed: (email) => tolerant(isSuppressed(email), false),
    sendEmail: (m) => sendCompanyEmail(m, { dryRun: false }),
    log: (line) => process.stdout.write(`${line}\n`),
    writePreview: (file, text) => writeFileSync(resolve(out, "preview", file), text),
    recordSent: (rec) => { sentLog.push(rec); writeFileSync(sentPath, `${JSON.stringify(sentLog, null, 2)}\n`); },
    recordError: (line) => appendFileSync(resolve(out, "errors.log"), `${line}\n`),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    store: {
      findByEmail,
      usedCount,
      async insertPending(r, token) {
        writeGuard();
        const [row] = await db().insert(I).values({ token, email: r.email, name: r.name, org: r.org, sourceUrl: r.sourceUrl })
          .onConflictDoNothing().returning(cols);
        const got = row ?? (await findByEmail(r.email));
        if (!got) throw new Error(`insert conflicted but no invite row found for ${r.org}`);
        return got;
      },
      async claim(id) {
        writeGuard();
        const rows = await db().update(I).set({ status: "sending" }).where(and(eq(I.id, id), eq(I.status, "pending"))).returning({ id: I.id });
        return rows.length === 1;
      },
      async markSent(id, s) {
        writeGuard();
        await db().update(I).set({ status: "sent", messageId: s.messageId, threadId: s.threadId, sentAt: s.sentAt }).where(eq(I.id, id));
      },
      async markFailed(id) {
        writeGuard();
        await db().update(I).set({ status: "failed" }).where(and(eq(I.id, id), eq(I.status, "sending")));
      },
      async release(id, status) {
        writeGuard();
        await db().update(I).set({ status }).where(and(eq(I.id, id), eq(I.status, "sending")));
      },
      async markSuppressed(id) {
        writeGuard();
        await db().update(I).set({ status: "suppressed" }).where(and(eq(I.id, id), eq(I.status, "pending")));
      },
    },
  });
  process.stdout.write(`done: ${JSON.stringify(summary)}\n`);
}

main().then(() => process.exit(0)).catch((e) => { process.stdout.write(`failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
