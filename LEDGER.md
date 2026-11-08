# Track A ledger

Handoff file. Any agent (Claude Code, Codex, a human) resumes from here. When you change something, update the feature table, Next steps, and append to the Log. Commit with each merge (AGENTS.md).

Read first: PLAN.md, TRACKS.md, docs/TRACK_A_PLAN.md (decisions, API surface), docs/EXPERT_NETWORK.md, docs/MCP.md, docs/INTEGRATION.md, docs/DEMO_SCRIPT.md, docs/DESIGN_V4.md.

Branch: `track-a` (HEAD 65a653d). Origin: `https://github.com/azoghby/standard-evals.git`. Track B work was merged into track-a from `integrate-b`. Do not edit Track B directories (`packages/core/src/{agents,evals,targets,simulator,reporting}`) from Track A work.

Last recorded prod deploy: the v4 redesign (~19:30 PT). The x402 commit (1d56f4b) and the Track B merge (65a653d) are on track-a, but no deploy is recorded for them.

## 1. What the product is

Standard Evals (repo and package name still `autonomous-evals`) is a company run by agents that evaluates other companies' AI agents. A customer submits a trace or a live endpoint. The Commercial agent qualifies it and returns a quote; code sets the price, never an agent. The customer pays through Stripe Checkout, either a fixed package price or per confirmed finding ($3 each, capped at $15, $0 if nothing is real). A durable Workflow tests the target, records confirmed findings, proposes and verifies fixes with before/after pass counts, and delivers a report. Customers are humans in the web app or agents over MCP (`/api/mcp/mcp`). x402 USDC payments on Base Sepolia testnet are merged. Human experts are hired for domain ground truth, and every outreach is approval-gated. The eval engine is mock by default; the real Track B engine is wired behind `EVAL_SERVICES=real` but not switched on.

Packages: `trace_audit`, `text_eval`, `workflow_eval` ($5 fixed, $15 cap each), `version_comparison` ($10 fixed, $30 cap).

## 2. How to run

```bash
npm install
cp .env.example .env            # values: `vercel env pull --scope agents-db31` or ask the owner
cp .env apps/web/.env.local      # app reads apps/web/.env.local; add AUTH_DEV_LINKS=1 for local sign-in
npm run dev                      # http://localhost:3000 (sign in at /signin; link shown on page in dev)
npm test                         # vitest
npx tsc -p apps/web --noEmit     # typecheck (also: npm run typecheck:all)
npx drizzle-kit generate --name <x> && npx drizzle-kit migrate   # schema changes (uses DATABASE_URL_UNPOOLED)
```

Deploy:

```bash
npm run deploy                   # = drizzle-kit migrate && vercel deploy --prod --yes --scope agents-db31
```

Caveat: `vercel deploy` ships the working tree, not a commit. When other workers have uncommitted files, deploy from a clean worktree instead:

```bash
git worktree add --detach <dir> <commit>
cp -r .vercel .env <dir>/        # both git-ignored; the worktree does not have them
cd <dir> && npm run deploy
```

A locked worktree from an earlier worker exists at `.claude/worktrees/agent-aa9ef0a080f1ae61a` (integrate-b). Do not delete it without owner OK.

E2E and dev-only checks. These flags must never be set on prod:

```bash
# target dev server with mock services (NODE_ENV=development, not prod)
AUTH_DEV_LINKS=1 DEV_SIMULATE_PAYMENTS=1 npm run dev -w web -- -p 3100
npx tsx scripts/e2e-pipeline.ts --base http://localhost:3100          # signs in, quotes, simulates payment, verifies delivery
E2E_PIPELINE=1 E2E_BASE_URL=http://localhost:3100 OPERATOR_EMAILS=<first operator> npx playwright test e2e/pipeline.spec.ts
E2E_PIPELINE=1 E2E_BASE_URL=http://localhost:3100 npx playwright test e2e/clarify.spec.ts
npm run e2e                      # playwright smoke (starts npm run dev on :3000 unless E2E_BASE_URL is set)
```

Other scripts:

```bash
npx tsx --env-file=.env scripts/demo-seed.ts                 # dry run (default, no network)
npx tsx --env-file=.env scripts/demo-seed.ts --apply         # idempotent seed (test env, is_mock=true)
npx tsx --env-file=.env scripts/demo-seed.ts --reset --apply # removes only the demo customer's rows
npx tsx scripts/conformance.ts [--skip-branching] [--skip-suite]   # Track B conformance (exit 0 = clean)
npx tsx scripts/ai-smoke.ts                                  # one structured call per model provider
npx tsx scripts/stripe-setup.ts                              # see scripts/stripe-smoke.md for the test checklist
npx tsx scripts/x402-pay-demo.ts --address                   # print payer address and balances
npx tsx scripts/x402-pay-demo.ts <jobId>                     # pay a quoted test job in USDC (testnet)
```

## 3. Infrastructure (live)

Secret values are not recorded here. Names only. Look them up in `vercel env pull` or ask the owner.

| Thing | Value |
|---|---|
| Vercel | project `autonomous-evals`, scope `agents-db31`, root dir `apps/web`, https://autonomous-evals.vercel.app |
| Vercel crons | `vercel.json`: reconcile-payments `*/5`, stale-jobs `*/10`, cleanup hourly, monitoring `0 9 * * *`, follow-ups `*/30`. All require `CRON_SECRET` |
| GitHub | repo `azoghby/standard-evals` (renamed; origin updated). Vercel GitHub auto-deploy is NOT connected (earlier link failed against the old name). Deploy via CLI |
| Neon (current) | `icy-star-64097833`, PG 18, aws-us-east-2, db `app`. main `br-long-voice-bdogu70i` (Realtime on, Storage on, pg_stat_statements on), sim-seed `br-dry-wave-bdhrghkh` |
| Neon snapshots | `pre-demo-baseline` (`snap-fragrant-mouse-bdhvrb2y`); daily schedule 12:00 UTC, kept 48h |
| Neon storage | private bucket `artifacts` on main (artifacts default here, Vercel Blob is the fallback) |
| Vercel Blob | private store `autonomous-evals-artifacts` (fallback) |
| Email | AgentMail (`AGENTMAIL_API_KEY` set; commercial and auth inboxes; inbound webhook `ep_3LnO5TpiMamhUvPG3Kik5WKeN8n`). Resend is the fallback (no key) |
| Monid | CLI logged in (key `main`, $20); `MONID_API_KEY` on Vercel, for expert contact research |
| Env on Vercel | DATABASE_URL(_UNPOOLED), SESSION_SECRET, CREDENTIALS_ENCRYPTION_KEY, CRON_SECRET, OPERATOR_EMAILS, STRIPE_MODE=test, APP_URL, BLOB_READ_WRITE_TOKEN, NEON_PROJECT_ID, NEON_MAIN_BRANCH_ID, NEON_SIM_SEED_BRANCH_ID, NEON_STORAGE_*, NEON_REALTIME_*, NEON_AI_GATEWAY_*, MONID_API_KEY, AGENTMAIL_* |
| Stripe (test) | `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` set (local + Vercel, all envs). Webhook endpoint `we_1UZHThPZwqSpk1TEM1CBUa5n` → /api/stripe/webhook |
| Neon API | `NEON_API_KEY` set (local + Vercel) |
| AI gateway | Vercel AI Gateway (OIDC on Vercel), fallback Neon AI Gateway (`NEON_AI_GATEWAY_URL` / `NEON_AI_GATEWAY_KEY`) |
| x402 (testnet) | Base Sepolia (`eip155:84532`). `X402_PAY_TO` (receiving address; route returns 503 when unset, Vercel status not recorded). Payer key `X402_PAYER_PRIVATE_KEY` is local demo only, testnet only. Facilitator default `https://x402.org/facilitator` |
| Track B (Naïve) | NOT set: `NAIVE_API_KEY`, `NAIVE_AGENT_COMMERCIAL`, `NAIVE_AGENT_EVALUATION_ENGINEER`, `NAIVE_AGENT_QUALITY_INVESTIGATOR`, `NAIVE_AGENT_COMPANY_OPERATOR` |
| Email footer | `COMPANY_ADDRESS` = sender identity only (owner has no postal address; CAN-SPAM wants one before real cold outreach) |
| **Missing** | live Stripe key (only after PLAN §9 gates); a postal address (virtual mailbox) before cold outreach at volume; Naïve keys (for real eval mode) |

## 4. Feature inventory

Status: live (deployed and working), merged (on track-a, deploy not recorded or not verified here), mock-only (runs only on mock eval services), needs-key (blocked on env or funding), not started.

| Feature | Status | Key files |
|---|---|---|
| Landing, v4 "Precision Black" redesign, /sample, share pages | live (v4 deployed ~19:30) | apps/web/src/app/page.tsx, components/marketing, docs/DESIGN_V4.md, app/sample |
| Magic-link auth, sessions, operator allowlist | live | apps/web/src/app/api/auth, server/session |
| Intake → quote → Stripe Checkout (fixed price) | live, test mode | app/(app)/start, api/jobs, server/job-store, workflows/job.ts |
| Stripe webhook, idempotent payments, reconcile cron | live, test mode (Gate 3 passed) | api/stripe/webhook, api/cron/reconcile-payments |
| Pay per confirmed finding (manual capture, $3 each, $15 cap) | live, test mode | workflows/steps/billing.ts, contracts (PER_FINDING_CENTS) |
| Durable jobWorkflow, resumable runs, stale-job recovery | live | workflows/job.ts, workflows/events.ts, api/cron/stale-jobs |
| Monitoring subscription ($49/mo) and follow-ups | live, test mode | api/cron/monitoring, api/cron/follow-ups, server/follow-ups.ts |
| Eval engine (Track B) | mock by default; real wired behind EVAL_SERVICES=real (not enabled) | packages/core/src/integration/, server/services.ts |
| Fix, not just find (remediations, before/after verification) | mock-only (Track B proposeAndVerifyFix not implemented) | workflows, remediations table, report page |
| Fix as GitHub PR (migration 0012) | merged; end-to-end not verified in this ledger | server/github-service.ts, server/github-pr.ts |
| Red-team pack (REDTEAM_PACK, default on) | merged; only runs in text/workflow suites, which need the real engine | packages/core/src/redteam/ |
| Public share links /r/[token], verified badge, revenue counter (migration 0011) | live | app/r, api/stats, packages/core/src/ |
| Reports and artifacts (Neon storage, Blob fallback, sanitized HTML) | live | packages/core/src/storage/, api/jobs/[id]/artifacts/[kind] |
| Neon Realtime live progress and operator live view | live (beta); polling fallback every 3 s | server/realtime.ts, api/jobs/[id]/live, api/operator/live, lib/client/use-live-*.ts |
| MCP server (8 tools, sample resource, prompts) | live | apps/web/src/app/api/mcp/[transport]/route.ts, docs/MCP.md |
| API keys for MCP | live | app/(app)/settings/keys, api/keys |
| Rate limit, BotID, Vercel Firewall | live (BotID blocks scripted job creation) | server/rate-limit.ts, server/bot.ts |
| Target URL guard (DNS-aware, SSRF) | merged | packages/core/src/targets/adapters.ts (be522f1) |
| Operator console (overview, interventions, outreach, experts, infra, live) | live | app/(app)/operator, api/operator/* |
| Operator alert emails (failed, paused, stale, payment-review; deduped) | merged; sends via AgentMail | commit 516e574, packages/core/src/email/ |
| Email transport and inbound webhook | live | packages/core/src/email/, api/webhooks/agentmail |
| Expert network MVP: /experts opt-in, /expert/r/[token] questionnaire, opt-out, operator tab | live; outreach approval-gated | app/experts, app/expert, api/experts, server/experts.ts |
| Expert call booking (slots, Jitsi, .ics) | live | server/expert-calls.ts, /expert/book/[token] |
| Expert contact research via Monid | not started (key set, pipeline not built) | docs/EXPERT_NETWORK.md |
| Expert Google Calendar booking (phase 2) | not started | docs/EXPERT_NETWORK.md |
| x402 agent payments (USDC, Base Sepolia testnet) | merged (1d56f4b); needs-key (X402_PAY_TO; payer funding) | packages/core/src/payments/x402*.ts, server/x402-pay.ts, api/x402/jobs/[jobId]/pay, scripts/x402-pay-demo.ts |
| Demo seed data | script ready, run on demand (dry run default) | scripts/demo-seed.ts |
| Expert AI voice interviewer (stretch) | not started | docs/EXPERT_NETWORK.md |
| Stripe live mode | not started; gated by PLAN §9 | STRIPE_MODE, scripts/stripe-setup.ts |

## 5. Track B integration status

Source: docs/INTEGRATION.md and the 65a653d merge.

Merged into track-a. **Prod now runs `EVAL_SERVICES=lite`** (set Nov 7 evening): `packages/core/src/lite/` implements all 11 eval methods via the AI gateway + SSRF-safe target transport, no Naïve needed. `EVAL_SERVICES=real` uses Track B and falls back to lite for unavailable methods; unset/`mock` = fixtures. Lite gaps: `rerunFinding`/`investigate` rely on in-run reruns on serverless (no target in signature); fix verification is single before/after; no simulated DB for workflow evals. Rollback: `vercel env rm EVAL_SERVICES production` + redeploy.

Real and wired through `packages/core/src/integration/`:
- qualify, auditTrace, renderReport (Naïve agents on the Postgres session and budget stores; needs the keys below)
- checkTarget (SSRF-safe HTTPS transport; no key needed)
- createJobBranch, deleteJobBranch, getJobBranchConnection (Neon branching; needs NEON_* keys)

Not mapped; these throw `EvalServiceUnavailableError`, which the Workflow treats as fatal:
- designSuite, runSuite, investigate (so real text and workflow evals are not possible)
- proposeAndVerifyFix, rerunFinding (so real fixes are not possible)

Risk: the trace path calls proposeAndVerifyFix after auditTrace. With real services that throws, so a real trace audit is unlikely to complete until this is verified.

NO-GO for `EVAL_SERVICES=real` until all of these are done:
1. Naïve keys set (NAIVE_API_KEY and the four agent IDs). Not set today.
2. Track B migrations reviewed, then applied once, on a Neon branch first. None are applied to any database yet. Per INTEGRATION.md: `agents/persistence-migrations/001-agent-persistence.sql` and `simulator/ledger-migrations/001_branch_ownership.sql` go on the app DB; `simulator/migrations/001_calendar.sql` goes on the sim-seed branch.
3. Budget-0 enforcement: the Track B adapter must refuse spend when `ctx.budgetMicroUsd` is 0 (conformance "budget" check).
4. `npx tsx scripts/conformance.ts` passes with no FAIL.

## 6. Open issues and risks

Payments and billing
- Per-finding settlement and email sweep after a restart is missing. I found no sweep in `api/cron/stale-jobs/recovery.ts`. If a run restarts after delivery, captures, releases and the customer email may not be swept.
- x402: concurrent payments on the same quote are not clearly guarded. An indeterminate settle leaves the payment recorded but not delivered to the workflow; the reconcile cron retries it (`server/x402-pay.ts`, around line 167). Needs an idempotent settle keyed on quote version and transaction.
- Test rows in the prod DB from `stripe-e2e@example.com` (Gate 3 runs). `scripts/e2e-pipeline.ts` uses `e2e-pipeline@example.com`, so running it against prod adds more. Console revenue counts only `environment = live`, but the rows still appear in job lists.

Platform
- BotID blocks scripted prod smoke tests (Playwright is detected). Use a real browser for smoke checks. Do not weaken BotID for real users.
- Mock eval services: every prod job runs on mock services unless `EVAL_SERVICES=real`. Mock jobs are flagged `is_mock=true` and excluded from revenue and customer counts. The demo must say so.
- PLAN §9 must-pass checks other than the Gate 3 items are not recorded as done: redeploy mid-job resumes, bad signature rejected, private-IP targets blocked, exhausted budget pauses the job, other users cannot read jobs or artifacts.
- Neon cannot snapshot non-root branches, so per-job "re-run finding" rebuilds state from the frozen suite.
- Neon Realtime needs PG 18 and a us-east region; that is why the project moved.
- `AUTH_DEV_LINKS=1` must never be set in prod (anyone could sign in).

Security and compliance
- Keys pasted in chat during the hackathon must be rotated after the hackathon (Stripe test, Neon, Vercel Blob, AgentMail, Monid, AI Gateway, Naïve, and the x402 payer key if it was shared).
- CAN-SPAM: no postal address. `COMPANY_ADDRESS` is identity only. Required before any cold outreach at volume.

## Next steps (hackathon)

Freeze is Nov 8, 9:30 AM PT. Judging is Nov 8, 11:00 AM PT.

1. Deploy the frozen commit before 9:30 from a clean worktree (`npm run deploy`). Check that `/`, `/sample` and `/experts` return 200, cron routes return 401 without the secret, `AUTH_DEV_LINKS` is unset, and `STRIPE_MODE=test`.
2. Fund the x402 payer wallet with Base Sepolia USDC from the Circle faucet (no ETH needed). Confirm `X402_PAY_TO` is set on Vercel. Rehearse `scripts/x402-pay-demo.ts` once on a test job. If it is not stable by 9:30, drop x402 from the demo.
3. Rehearse the 3-minute flow in docs/DEMO_SCRIPT.md, including its fallbacks: paid Trace Audit with the 4242 test card, live progress, the seeded report, `claude mcp add`, and the operator console. Record the backup video between 9:30 and 11:00.
4. Run `npx tsx --env-file=.env scripts/demo-seed.ts --apply` right before going on stage. Do a dry run first. The running job's heartbeat goes stale after 15 minutes, and the stale-jobs cron can escalate it.
5. Real evals are live via the lite engine (conformance 18/18 live). Switch to `EVAL_SERVICES=real` only once Track B's section 5 prerequisites are done (Naïve keys, migrations on a Neon branch, budget-0 check).
6. Be ready to explain the test rows in prod (`stripe-e2e@`, `e2e-pipeline@`), or remove them.
7. After judging: rotate the pasted keys; fix the per-finding sweep and x402 settle idempotency; finish the PLAN §9 must-pass checks; add a postal address for CAN-SPAM. Sell audits to other teams with live Stripe only after the PLAN §9 gates pass (`STRIPE_MODE=live` plus the live key).

## Log

Times are PT, as recorded.

- Nov 7, 13:45 to 16:45: scaffold, contracts, schema, first deploy. Parallel workers merged: landing, app screens, auth, workflow and Stripe, crons, test infra. Neon moved to PG 18 us-east-2. AgentMail, Firewall rate limits, booking, Stripe setup, Neon storage and ops, v3 retheme, /sample, AI gateway, conformance harness, shared adapters, e2e pipeline. Old Neon projects `sparkling-frost-08478178` and `long-shape-06677281` deleted (owner OK, both empty). Stripe test keys, webhook, NEON_API_KEY and COMPANY_ADDRESS configured.
- ~17:10: Gate 3 passed on prod (Stripe test mode). Pay → delivered; duplicate webhook ignored; missed webhook recovered by the reconcile cron (job `ce4ba9e4…`). BotID blocks scripted job creation.
- ~17:40: prod redeploy with security fixes, MCP hire flow, stale-job recovery, report polish, landing Lighthouse perf 96 and a11y 100, OG, robots and sitemap.
- ~18:30 to 19:30: red-team pack, fix-as-GitHub-PR (migration 0012), x402 work started, public share links and revenue counter (migration 0011), resumable workflow and stale-job auto-restart. Track B merged into `integrate-b` (71ef424); `EVAL_SERVICES=real` wired. v4 redesign deployed (~19:30) with a clean-worktree deploy.
- After ~19:30 (no times recorded): x402 commit 1d56f4b and Track B merge 65a653d on track-a. Deploy not recorded for either.
- Evening (post-4 PM): lite eval engine (7771433) committed; prod set to `EVAL_SERVICES=lite` and redeployed (dpl_8Z4YTS2reToQNsBxdjxPDjMnBsrL). Public agents seeded and run live on standard-suite-v1 (32 scenarios, ~$0.003 each): Sonnet 4.5 75%, GPT-5 mini 75%, Llama 3.3 70B 72%, Haiku 4.5 69%, Gemini 2.5 Flash 63%. Landing has 5-min ISR + leaderboard teaser. `scripts/public-agents.ts` falls back to `VERCEL_OIDC_TOKEN` (`--env-file=apps/web/.env.vercel.local`). Prod smoke: /, /leaderboard, /sample, revenue 200; x402 pay 401 without payment.
- Evening: prod gateway fix verified (job 0b46c968…, 38 ai_gateway cost rows, $0.075, LLM-designed suite). `AI_GATEWAY_API_KEY` created (name standard-evals-prod, $50/mo cap, expires in 30d) and set in .env + Vercel prod/preview/dev; OIDC remains fallback. Landing visual upgrade deployed (pipeline diagram, report/fix showpieces, integrations marquee, MCP terminal, pricing spotlight, expert graph, leaderboard bars, revenue band). Open: Neon snapshot/TTL step 404 'parent branch not found' (non-blocking).
