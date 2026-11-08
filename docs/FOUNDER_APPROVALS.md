# Founder approvals and phone notifications

You (the founder, the first address in `OPERATOR_EMAILS`) are the final confirm. The company sends you:

- **Approval requests in real time**: outreach drafts (Approve & send / Reject), new enterprise leads (Mark contacted).
- **FYIs**: Agent Audit and plan purchases, failed jobs, jobs paused on budget, payments needing review, stale jobs.
- **A daily report** at 15:00 UTC: revenue (live vs test), signups, runs and pass rate, spend vs budget, what is pending, failures, and the top 3 things to do.

Channels, all optional, used in this order:

| Channel | What you get | How you answer |
|---|---|---|
| Telegram (recommended, free, 5 min) | Message with **Approve / Reject / View** buttons | Tap a button (or reply `YES 12` / `NO 12`) |
| WhatsApp (Twilio) | Text message | Reply `YES 12` or `NO 12` |
| Email (fallback) | Email with one-click links | Click, then press **Confirm** on the page that opens |

Email is only used when no phone channel delivered (set `FOUNDER_NOTIFY_EMAIL=always` to always get email too). Nothing breaks if a channel is not set up; it is skipped.

Why not the Vercel Chat SDK: it has Telegram and WhatsApp adapters, but its WhatsApp adapter is Meta's WhatsApp Business Cloud API (not Twilio) and it needs a Redis/Postgres state adapter and its own thread model. We only need "send one message with buttons, receive one tap", so the adapters here are ~150 lines each, with no new dependencies, and unit-tested with a mocked `fetch`.

---

## 1. Telegram setup (5 minutes)

1. **Create the bot.** In Telegram, open a chat with **@BotFather**, send `/newbot`, pick a name (e.g. "Standard Evals Ops") and a username ending in `bot` (e.g. `standard_evals_ops_bot`). BotFather replies with a **token** like `123456789:AA...`. Keep it secret.
2. **Make a webhook secret** (any random string, letters/digits only):
   ```bash
   openssl rand -hex 32
   ```
3. **Add the env vars to Vercel** (run in the repo root; paste the value when asked; choose Production):
   ```bash
   vercel env add TELEGRAM_BOT_TOKEN production --scope agents-db31
   vercel env add TELEGRAM_WEBHOOK_SECRET production --scope agents-db31
   vercel env add TELEGRAM_BOT_USERNAME production --scope agents-db31   # optional, e.g. standard_evals_ops_bot (no @)
   ```
   Then redeploy (`npm run deploy`) so the app sees them.
4. **Point Telegram at the app** (replace the two values; run once, from any terminal):
   ```bash
   curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -d "url=https://standard-evals.vercel.app/api/notify/telegram" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
     -d 'allowed_updates=["message","callback_query"]'
   ```
   It should print `{"ok":true,"result":true,"description":"Webhook was set"}`.
5. **Link your phone.** Open https://standard-evals.vercel.app/operator, tab **Notifications**, press **Generate link code**. Tap the link shown (or open your bot in Telegram and send `/start <code>`). The bot answers "Linked." The code works once and expires after 15 minutes. Your chat id is stored in the database, so you never need `TELEGRAM_FOUNDER_CHAT_ID` (it exists only as an optional fallback).
6. Press **Send test message** in the Notifications tab. You should get it in Telegram within seconds.

Only your linked chat can approve anything. Other people who find the bot get "Not authorized."

## 2. WhatsApp setup with the Twilio sandbox (5 minutes)

1. Create a free account at https://www.twilio.com/try-twilio. In the Console home page copy the **Account SID** and **Auth Token**.
2. Open **Messaging > Try it out > Send a WhatsApp message**. Twilio shows a sandbox number (e.g. `+1 415 523 8886`) and a **join code** (e.g. `join purple-tiger`). From your phone, send that join code to that number on WhatsApp. Twilio confirms you joined. (The sandbox needs this re-join every 72 hours of inactivity; a paid WhatsApp sender does not.)
3. On the same page open **Sandbox settings**. Set **When a message comes in** to
   `https://standard-evals.vercel.app/api/notify/whatsapp`, method **POST**, and save.
4. Add the env vars to Vercel, then redeploy:
   ```bash
   vercel env add TWILIO_ACCOUNT_SID production --scope agents-db31
   vercel env add TWILIO_AUTH_TOKEN production --scope agents-db31
   vercel env add TWILIO_WHATSAPP_FROM production --scope agents-db31     # the sandbox number, e.g. +14155238886
   vercel env add FOUNDER_WHATSAPP_TO production --scope agents-db31      # optional: your number, e.g. +14155551234
   ```
   Instead of `FOUNDER_WHATSAPP_TO` you can type your number in **/operator > Notifications > WhatsApp** (stored in the database; it wins over the env var).
5. Press **Send test message**. Reply `YES 12` / `NO 12` to approval messages (the number is the `#12` at the top of each message).

Only messages from your number are accepted. Every inbound request must carry a valid `X-Twilio-Signature`; if Twilio calls a URL different from `https://standard-evals.vercel.app/api/notify/whatsapp` (custom domain), set `TWILIO_WEBHOOK_URL` to that exact URL.

## 3. Email-first (set `FOUNDER_EMAIL`, no phone channel needed)

Set `FOUNDER_EMAIL=you@example.com`. It takes precedence over the first `OPERATOR_EMAILS` entry as the founder address and identity (decision actor, recipient). With no Telegram/WhatsApp bound, every approval request and the daily report goes there, sent from the commercial AgentMail inbox so your replies come back through the existing `/api/webhooks/agentmail` webhook (Svix signature verified first).

Subjects: `[Approve #12] <title>`, `[FYI] <title>`, `Standard Evals daily report — <date>`.

Reply to the email (first non-quoted line only; quoted history and signatures are ignored):

| Reply | Effect |
|---|---|
| `YES`, `Y`, `APPROVE`, `OK`, 👍 | approve the approval that email was about |
| `NO`, `N`, `REJECT`, 👎 | reject it |
| `YES 12` / `NO 12` | decide #12 explicitly (works from any founder thread) |
| `YES ALL` | approve and send every pending outreach draft (same path as the approve-all link; guardrails apply) |
| anything else | saved as a **founder note**; no action is taken; you get a short help reply |

Only a bare command line counts: a sentence that starts with "yes" or "no" is a note. You get a confirmation reply ("Approved #12 — sent." / "Rejected #12."). Decisions use the same idempotent state machine, are audit-logged, and record `decided_via = email_reply`; a replayed webhook or second YES changes nothing.

Anti-spoofing (all must hold): the sender equals `FOUNDER_EMAIL` (case-insensitive); the reply is on a thread we started (`founder_email_threads`, written when the email is sent); and if AgentMail reports SPF/DKIM/DMARC verdicts for the message, none may fail and at least one must pass. When AgentMail reports no verdicts, the thread match carries the check.

Founder notes appear in /operator > Notifications > Founder notes and in the next daily report. They never trigger actions. Tables: `founder_email_threads`, `founder_notes` (migration 0020).

## 3b. Email fallback (links)

Uses the existing email transport (AgentMail, or Resend fallback). Nothing to set up beyond what already sends operator alerts. Links are HMAC-signed with `SESSION_SECRET`, bound to one approval and one decision, expire after 24 hours, and work once (the approval can only change while pending). Opening a link never changes anything (mail scanners prefetch links); you must press **Confirm** on the page.

## 4. Daily report

Vercel Cron calls `GET /api/cron/founder-report` at 15:00 UTC (`apps/web/vercel.json`, `CRON_SECRET` required). It runs under a Postgres advisory lock and at most once per UTC day (a `follow_ups` claim row; released if nothing was delivered so a manual re-run can retry). It also marks expired approvals. Optional: `DAILY_SPEND_BUDGET_USD` (overall daily spend budget shown in the report; public agents use `PUBLIC_AGENT_DAILY_BUDGET_USD`). Manual run:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://standard-evals.vercel.app/api/cron/founder-report
```

## Env vars

| Name | Required for | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram | From BotFather. |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram | Same value passed as `secret_token` to `setWebhook`. |
| `TELEGRAM_BOT_USERNAME` | optional | Enables the one-tap `t.me` link; otherwise fetched with `getMe`. |
| `TELEGRAM_FOUNDER_CHAT_ID` | optional | Fallback when no chat is linked in the DB. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` | WhatsApp | From the Twilio console. |
| `FOUNDER_WHATSAPP_TO` | optional | Fallback when no number is saved in the DB. |
| `TWILIO_WEBHOOK_URL` | optional | Exact public webhook URL if not `${APP_URL}/api/notify/whatsapp`. |
| `FOUNDER_EMAIL` | email-first | Founder address and identity; overrides first `OPERATOR_EMAILS`. Set in prod. |
| `FOUNDER_NOTIFY_EMAIL` | optional | `always` = also email when a phone channel delivered. |
| `DAILY_SPEND_BUDGET_USD` | optional | Daily spend budget line in the report. |
| existing: `OPERATOR_EMAILS`, `SESSION_SECRET`, `CRON_SECRET`, `APP_URL`, email transport | | First `OPERATOR_EMAILS` entry is the founder identity on phone decisions. |

## Routes

| Route | Purpose |
|---|---|
| `POST /api/notify/telegram` | Telegram webhook. Verifies `X-Telegram-Bot-Api-Secret-Token`; rate-limited; handles `/start <code>`, button taps, `YES n` / `NO n`. |
| `POST /api/notify/whatsapp` | Twilio inbound webhook. Verifies `X-Twilio-Signature`; rate-limited; only the founder number; TwiML reply. |
| `GET /notify/decide?t=...` | Email link confirm page (read-only). |
| `POST /api/notify/decide` | The email confirm button (mutates; rate-limited). |
| `GET/POST /api/operator/notify` | Operator-only: channel status, link code, WhatsApp number, test message, approval list, console decide. |
| `GET /api/cron/founder-report` | Daily report cron. |

## Data

- `founder_approvals`: `id, seq (the #12), kind, title, summary, ref, payload, status (pending|approved|rejected|expired|fyi), decided_via, decided_by, decided_at, result, expires_at, channel_refs, created_at`. Unique `(kind, ref)`: asking twice is a no-op.
- `founder_notify_settings`: one row (`id = 'founder'`) with the linked Telegram chat id, a hashed one-time link code, and the WhatsApp number.
- Every decision writes an `interventions` row (`kind = 'founder_decision'`): the audit log.

Safety: decisions are idempotent (only `pending -> approved|rejected` once, atomic `UPDATE ... WHERE status = 'pending'`); a double tap, a replayed webhook or a reused email link is a no-op that tells you it was already handled. Summaries are passed through secret redaction and email addresses are shortened to `j***@acme.io`. Deciding an outreach draft from the phone calls the same `approveAndSendDraft` path as the console (suppression list, daily caps); approving or rejecting in the console closes the matching phone approval.

---

## For agents: `requestFounderApproval`

`apps/web/src/server/notify/approvals.ts`

```ts
import { requestFounderApproval } from "@/server/notify/approvals";

// Decision (buttons): kind must have a registered handler.
await requestFounderApproval({
  kind: "company_outreach",            // /^[a-z][a-z0-9_]{1,47}$/
  title: "Outreach to Acme (CS agent)", // <= 120 chars shown
  summary: "Why, what we'd send, expected value. Emails are redacted automatically.",
  ref: draftId,                          // stable id; (kind, ref) unique, re-requests are no-ops
  payload: { anything: "small, JSON" },  // optional, available to the handler
  expiresInMs: 3 * 24 * 3600_000,        // optional, default 7 days
});

// FYI (no buttons, no handler needed):
await requestFounderApproval({ kind: "company_research", title: "Research done", summary: "...", ref: runId, fyi: true });
```

It never throws (returns `{ ok:false, error }`), so it is safe inside workflows. It returns `{ ok:true, created, id, seq, results }` where `results` is the per-channel outcome.

**Handlers** run when the founder decides. Because the decision arrives in a different serverless request (the webhook), handlers are a registry by kind, not a callback argument. Register them in a module that `apps/web/src/server/notify/handlers.ts` imports (add one import line there), so every entry point has them:

```ts
// apps/web/src/server/company/approval-handlers.ts
import { registerApprovalHandler } from "@/server/notify/registry";

registerApprovalHandler("company_outreach", {
  approveLabel: "Approve & send",
  rejectLabel: "Reject",                 // or null for single-action items
  viewPath: (a) => "/operator",          // where the View button goes
  async onDecision({ approval, decision, via, actor }) {
    // Runs exactly once per approval, after the atomic pending -> decided claim.
    // Do the real thing (send, schedule, ...). Return a short note shown to the founder.
    return { ok: true, note: decision === "approve" ? "Sent." : "Discarded." };
  },
});
```
```ts
// apps/web/src/server/notify/handlers.ts (add)
import "../company/approval-handlers";
```

If something is decided elsewhere (e.g. in your own console UI), call `closeApprovalFromSource(kind, ref, "approved" | "rejected", actorEmail)` from `@/server/notify/sync` so the phone buttons become no-ops.

**Daily plan**: make `getTodaysPlan()` in `apps/web/src/server/notify/daily-plan.ts` return the CEO planner's bullets for today (or `null`); they appear in the daily report under "Today's plan".

Built-in kinds: `outreach_draft` (approve = `approveAndSendDraft`), `sales_lead` (Mark contacted), FYI: `plan_purchase`, `agent_audit_purchase`, `operator_alert` (every `alertOperators()` call except kinds that already have their own approval).
