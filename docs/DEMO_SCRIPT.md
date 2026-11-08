# Judge demo: 3 minutes (Nov 8, judging 11:00 AM PT)

Base URL: https://autonomous-evals.vercel.app

One sentence to anchor everything: **an AI company that finds the bug in your agent, fixes it, proves the fix, and only charges you for findings that are real.**

## Honest status (say this out loud if asked, never hide it)

- Payments are **real Stripe, TEST mode** (4242 card). No real money moves. `STRIPE_MODE=test`.
- The eval engine behind the report is the **mock eval service** until Track B lands. Mock jobs carry `is_mock=true`, are never counted as revenue or customers, and the report says so. The pipeline around it is real: Workflow DevKit, Stripe, Neon Realtime, storage, MCP, operator console.
- Seeded demo jobs (`demo@autonomous-evals.dev`) are also test + mock. They exist so the console and a finished report are never empty.
- Expert network outreach is approval-gated; nothing is sent to real experts during the demo.

## Timeline

| Time | Step | Screen |
|------|------|--------|
| 0:00-0:20 | Problem | Landing `/` |
| 0:20-1:10 | Submit a Trace Audit, pay | `/start` then Stripe Checkout |
| 1:10-1:35 | Live progress | `/jobs/<id>` |
| 1:35-2:05 | Report: validated fixes + pay per finding | delivered job (seeded) |
| 2:05-2:25 | MCP: an agent hires us | terminal |
| 2:25-2:50 | Operator console | `/operator` |
| 2:50-3:00 | Why it is defensible | landing or console |

Tip: Stripe checkout and the fresh run take time. Start the live job at 0:20, then **narrate while it runs**, and jump to the already-delivered seeded job for the report (step 4). Do not wait on the clock.

### 0:00 Problem (landing `/`)
Say: "Teams ship AI agents that say 'refund issued' when the refund tool actually failed. Eval tools hand you a dashboard and a to-do list. Nobody does the work. We are a company run by agents that does the eval work, fixes what it finds, and gets paid per confirmed finding."

### 0:20 Submit a trace audit (`/start`, signed in as demo)
Do: choose Trace Audit, paste the prepared trace (`e2e/fixtures/trace-unsupported-claim.json`, success claim after a 503), tick "authorized to test", submit.
Say: "This is a real support-bot trace. The agent claimed it booked a meeting after the calendar call returned 503."
Quote appears: choose **Pay per confirmed finding** ($3 per confirmed finding, $15 cap, $0 if nothing real). Click through to Stripe Checkout, card `4242 4242 4242 4242`, any future date, any CVC.
Say: "Real Stripe. Per-finding means the card is only authorized for the cap. We capture at delivery."

### 1:10 Live progress (`/jobs/<id>`)
Look for the blue pulsing **Live** indicator.
Say: "That is Neon Realtime pushing progress rows straight from Postgres. No polling. The job runs as a durable Workflow, so a redeploy mid-job resumes where it stopped."
If it falls back to polling the page still works; keep talking.

### 1:35 Report with validated fixes and the charge
Open the seeded delivered job (Trace Audit, listed first in `/jobs`) so you are not waiting on the live one.
Show: 2 confirmed findings with evidence, then **Validated fixes** (before 0/3, after 3/3, regressions 0), then the billing line: "2 confirmed findings x $3 = $6 captured of a $15 hold; the rest was released." Click download report.
Say: "We do not stop at 'here is a problem'. Every confirmed finding ships with a patch we replayed against the frozen scenarios. And the rubric concern at the bottom is not billed because we could not reproduce it."

### 2:05 MCP: an agent hires us
Prerequisite: an API key from `/settings/keys` created before the demo (`AE_KEY`).
Run in a terminal already open:
```bash
claude mcp add --transport http autonomous-evals \
  https://autonomous-evals.vercel.app/api/mcp/mcp \
  --header "Authorization: Bearer $AE_KEY"
```
Then in Claude Code: "Use autonomous-evals to audit this trace and tell me what it costs" (the `hire_eval` prompt does it). Show `list_packages`, `create_job`, and the checkout URL returned by `accept_quote`.
Say: "Our customer can be another agent. Eight tools, one config line, Stripe link comes back for a human or a payment-capable agent. Card data never goes over MCP."

### 2:25 Operator console (`/operator`, operator email)
Show, in order: Overview (jobs, test vs live revenue, costs, the demo jobs flagged mock), interventions list (every time a human stepped in is logged), **Experts** tab (opt-in pool, pending outreach drafts awaiting founder approval), **Infra** tab (Neon: project, branches, snapshot `pre-demo-baseline`, storage bucket).
Say: "This is the company's control room. Humans only approve, refund, and intervene, and every intervention is on the record. For domain agents our agents hire human experts from this network for ground truth, always approval-gated. State, branches, snapshots and artifacts all live on Neon, so a finding re-runs on an isolated branch."

### 2:50 Why it is defensible
Say, four beats: "One, fix not just find, with before/after proof. Two, you pay per confirmed finding, so our incentive is precision, not volume. Three, distribution through MCP: agents buy evals the way they call any tool. Four, the expert network gives us domain ground truth that a pure-LLM competitor cannot copy. Eval platforms sell tools. We sell the finished work."

## Pre-demo checklist (do by 9:30 AM freeze, recheck at 10:30)

Envs and deploy
- [ ] Prod deployed from the frozen commit: `npm run deploy`; `/`, `/sample`, `/experts` return 200; cron routes 401 without secret.
- [ ] Vercel env present: `DATABASE_URL`, `STRIPE_SECRET_KEY` (sk_test_), `STRIPE_WEBHOOK_SECRET`, `STRIPE_MODE=test`, `AGENTMAIL_API_KEY`, `NEON_*`, `OPERATOR_EMAILS`. **`AUTH_DEV_LINKS` NOT set in prod.**
- [ ] Stripe test webhook endpoint is enabled and recent deliveries are 200.

Seed data (owner decides; see below)
- [ ] `npx tsx --env-file=.env scripts/demo-seed.ts` (dry run) looks right, then `--apply` at about 10:30 AM. The running job's heartbeat only stays fresh for 15 minutes before the stale-jobs cron (every 10 min) may escalate it: re-run `--apply` right before going on stage. `--reset --apply` removes everything it created.

Warm routes (open each once, 10:45)
- [ ] `/`, `/signin`, `/start`, `/jobs`, `/jobs/<seeded-trace-id>`, `/operator`, `/settings/keys`, `/sample`.
- [ ] Hit `/api/mcp/mcp` once with the curl `tools/list` example in `docs/MCP.md` to warm the function.
- [ ] Do one throwaway paid run in the morning so cold starts are over.

Sign-in links (magic links expire; BotID blocks scripted job creation, so use a real browser)
- [ ] Browser profile A: signed in as `demo@autonomous-evals.dev`. Request the link from `/signin`, open the email from AgentMail, stay logged in. Have the session open before you walk up.
- [ ] Browser profile B: signed in as the operator email (first in `OPERATOR_EMAILS`) on `/operator`.
- [ ] If AgentMail is slow: the sessions above are already live, so do not sign out.

Fixtures
- [ ] Trace JSON from `e2e/fixtures/trace-unsupported-claim.json` on the clipboard / a text file.
- [ ] `AE_KEY` created at `/settings/keys` and exported in the terminal; `claude mcp add` command ready (remove any old `autonomous-evals` server first: `claude mcp remove autonomous-evals`).
- [ ] Stripe test card `4242 4242 4242 4242` noted.

Backup
- [ ] Backup video recorded (9:30-11:00 per PLAN) of the full flow, saved locally AND on a phone. Plays offline.
- [ ] Screenshots of: delivered report, Live job page, operator console, Stripe test payment.

## Fallbacks

| If this breaks | Do this |
|---|---|
| Stripe Checkout down or slow | Skip the live payment. Say "Stripe test mode, here is a payment from earlier" and open the seeded delivered Trace Audit (payment captured $6 of $15) plus the Stripe dashboard payment from the Gate 3 run. |
| AgentMail / sign-in email not arriving | Use the already-signed-in browser profiles. Never sign out on stage. |
| Neon Realtime not live | The page silently falls back to polling every 3 s; say "it normally streams via Neon Realtime" and continue. |
| Live job slow or stuck | Switch to the seeded running job (`workflow_eval`) for progress, and the seeded delivered job for the report. |
| MCP add fails or rate limited (60 per 10 min) | Show the saved curl flow from `docs/MCP.md`, or the MCP section of the backup video. |
| Venue Wi-Fi dies | Phone hotspot first, then play the backup video and narrate it. |
| Anything throws a 500 | Do not debug on stage. Move to the next step; the seeded data covers every screen. |

## Likely questions (short honest answers)

- "Is the eval real?" The orchestration, payments, storage, realtime, MCP and operator layers are real and deployed. The eval services are mock until the real engine lands; mock jobs are flagged `is_mock` and excluded from revenue.
- "Real revenue?" Test mode only. No live Stripe key until the PLAN section 9 gates pass.
- "Why would anyone trust per-finding billing?" Only findings reproduced by an independent re-check are billed; rubric concerns and inconclusive ones are free.
- "Does the expert network email real people?" Only after a human approves each draft; suppression list and one-click opt-out enforced.
