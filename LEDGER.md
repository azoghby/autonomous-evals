# Track A ledger: what's done, what's in flight, what's next

This is a handoff file. Any agent (Claude Code, Codex, a human) should be able to resume from it.
Keep it current: append to **Log**, move items between sections, and commit with each merge.

Read first: [PLAN.md](PLAN.md), [TRACKS.md](TRACKS.md), [docs/TRACK_A_PLAN.md](docs/TRACK_A_PLAN.md) (decisions and API surface), [docs/EXPERT_NETWORK.md](docs/EXPERT_NETWORK.md).
Branch: `track-a` (pushed to origin). Track B lives on its own branch; don't edit its directories (`packages/core/src/{agents,evals,targets,simulator,reporting}`).

## How to run

```bash
npm install
cp .env.example .env            # values: `vercel env pull --scope agents-db31` or ask the owner
cp .env apps/web/.env.local      # app reads apps/web/.env.local; add AUTH_DEV_LINKS=1 for local sign-in
npm run dev                      # http://localhost:3000 (sign in at /signin; link shown on page in dev)
npm test                         # vitest
npx tsc -p apps/web --noEmit     # typecheck
npx drizzle-kit generate --name <x> && npx drizzle-kit migrate   # schema changes (uses DATABASE_URL_UNPOOLED)
vercel deploy --prod --yes --scope agents-db31                   # deploy (GitHub auto-deploy NOT connected)
```

## Infrastructure (live)

| Thing | Value |
|---|---|
| Vercel | project `autonomous-evals`, scope `agents-db31`, root dir `apps/web`, https://autonomous-evals.vercel.app |
| Neon (current) | `icy-star-64097833`, PG 18, aws-us-east-2, db `app`. main `br-long-voice-bdogu70i` (Realtime on, Storage on, pg_stat_statements on), sim-seed `br-dry-wave-bdhrghkh` |
| Neon snapshots | `pre-demo-baseline` (`snap-fragrant-mouse-bdhvrb2y`); daily schedule 12:00 UTC, kept 48h |
| Neon storage | private bucket `artifacts` on main (artifacts default here, Vercel Blob is the fallback) |
| Vercel Blob | private store `autonomous-evals-artifacts` (fallback) |
| Email | AgentMail (`AGENTMAIL_API_KEY` set); Resend is the fallback (no key) |
| Monid | CLI is logged in (key `main`, $20); `MONID_API_KEY` on Vercel, used for expert contact research |
| Env on Vercel | DATABASE_URL(_UNPOOLED), SESSION_SECRET, CREDENTIALS_ENCRYPTION_KEY, CRON_SECRET, OPERATOR_EMAILS, STRIPE_MODE=test, APP_URL, BLOB_READ_WRITE_TOKEN, NEON_PROJECT_ID, NEON_MAIN_BRANCH_ID, NEON_SIM_SEED_BRANCH_ID, NEON_STORAGE_*, MONID_API_KEY, AGENTMAIL_API_KEY (+ inbox IDs once created) |
| Stripe (test) | `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` set (local + Vercel all envs); webhook endpoint `we_1UZHThPZwqSpk1TEM1CBUa5n` → /api/stripe/webhook |
| Neon API | `NEON_API_KEY` set (local + Vercel) |
| Email footer | `COMPANY_ADDRESS` = sender identity only (owner has no postal address; CAN-SPAM wants one before real cold outreach) |
| **Missing** | live Stripe key only after PLAN §9 gates; a postal address (virtual mailbox) before cold outreach at volume |

## Done (committed on `track-a`)

- [x] Workspace scaffold (npm workspaces, Next 16.4, `@ae/core`), Workflow DevKit wired
- [x] Shared contracts (`packages/core/src/contracts/`) + `EvalServices` interface for Track B
- [x] Drizzle schema + migrations 0000–0002 (app tables, expert network, delivery snapshot)
- [x] Landing page + navy/cream/coral design system (v1)
- [x] Magic-link auth, sessions, operator allowlist, AES-GCM credential encryption, ownership checks (404 for non-owners)
- [x] Job APIs: create (idempotent), get, progress, messages, rerun finding, retest, artifacts download
- [x] Operator APIs: overview, interventions, outreach approve/reject (suppression and rate-limit guarded)
- [x] Durable `jobWorkflow`: qualify → clarify (≤3) → quote → accept → pay → run → report → deliver; budget reservations; paused_budget/failed/cancelled
- [x] Stripe: checkout per quote version, verified webhook, idempotent payments, cron reconciliation, monitoring subscription checkout
- [x] Crons: reconcile-payments, stale-jobs, cleanup (creds +24h, branch +48h), monitoring + follow-ups stubs; `apps/web/vercel.json`
- [x] Screens: signin, start (intake), jobs, job page (clarify/quote/progress/report), operator console; reconciled with the server shapes
- [x] Artifacts on Neon branchable storage, with the `neon:`/`blob:` pathname prefix
- [x] Neon ops: API client, delivery snapshot fn, branch TTL fn, `/api/operator/infra`, `<OperatorInfra/>`
- [x] Expert network MVP: opt-in `/experts`, questionnaire `/expert/r/[token]`, opt-out, operator expert APIs, `<OperatorExperts/>`
- [x] Tests: vitest harness (110+ tests), Playwright smoke, GitHub Actions CI
- [x] Docs: TRACK_A_PLAN.md, EXPERT_NETWORK.md (+ Monid endpoints)

## In flight (workers running; check `git status` for uncommitted work)

- [ ] Neon Realtime live progress + operator live view (`/api/jobs/[id]/live`, `/api/operator/live`, `server/realtime.ts`, `lib/client/use-live-*.ts`)
- [ ] Vercel hardening: Firewall rate limits, `server/rate-limit.ts` (Neon table), BotID, Speed Insights + Analytics, security headers, cron registration check, **prod deploy**
- [ ] AgentMail: inboxes (commercial, auth), `packages/core/src/email/`, inbound webhook `/api/webhooks/agentmail`, `email_threads` table
- [ ] UI v2 (calmer, fewer boxes, Motion + anime.js): landing/design system/experts page; app screens + operator tabs (Overview · Experts · Infra)

- [ ] Differentiators (in flight): **Fix, not just find** (remediations + before/after verification), **Pay per confirmed finding** (Stripe manual capture, $0 if nothing real), **MCP server** at `/api/mcp` with per-customer API keys so agents can hire us
- [ ] Workflow gaps: Neon delivery-safety step, pre-payment `checkTarget`, cancel route
- [ ] Wire `rateLimit` + `assertHuman` into request-link, POST jobs, expert signup
- [ ] Security review (opus, read-only); findings get fixed after

- [ ] E2E pipeline test (`scripts/e2e-pipeline.ts`, dev-only simulated payment)

### Merged since last update
- Shared Track B adapters on `ServiceContext` (`ctx.sessions`, `ctx.budget`, `ctx.artifacts`, `packages/core/src/adapters/`), live-smoked against Neon; e2e pipeline script/spec (`scripts/e2e-pipeline.ts`, `E2E_PIPELINE=1`); fixes: draft polling, report summary. Redeployed.
- Expert call booking (`call_slots`, Jitsi, .ics, `/expert/book/[token]`, operator slots + notes), real monitoring + follow-up crons (migration 0008/0009 applied), typed remediations, mobile nav. **Deployed to prod** (/, /sample, /experts 200; crons 401 without secret)
- UI v3 retheme (black/white/#2F6BFF, cursor-reactive ribbed lines), `/sample` public report, AI gateway (`@ae/core/ai/gateway`: Vercel primary, Neon fallback, cost logging, credential guard), Track B conformance harness (`npm run conformance`-style `scripts/conformance.ts`, docs/INTEGRATION.md)
- Pay per confirmed finding (Stripe manual capture), fix-not-just-find (remediations), MCP server (`/api/mcp/mcp` + `/settings/keys`), Neon Realtime live progress, security batches 1+2 + M4 (all HIGH/MEDIUM fixed), infra 500 fix, `npm run deploy` (migrate then deploy)

## Next steps (priority order)

1. ~~Gate 3~~ **PASSED on prod (Nov 7 ~17:10)**: real Stripe test-mode paid Trace Audit (job 26afb6a1…), duplicate webhook ignored, missed webhook recovered by reconcile cron (job ce4ba9e4…). Mock eval services. Old text: Create the webhook endpoint via the API → set `STRIPE_WEBHOOK_SECRET` → test duplicate and missed webhooks.
2. Add the Neon delivery-safety step to the workflow (`captureDeliverySnapshot` + `applyBranchTtl`, non-fatal) and a pre-payment `checkTarget` for Text/Workflow evals; add a cancel route.
3. Wire `rateLimit()` and `checkBotId()` into request-link, POST jobs and experts signup (snippets come from the Vercel worker report).
4. Must-pass checks (PLAN §9): redeploy mid-job resumes; bad signature rejected; private-IP target blocked (Track B); exhausted budget pauses the job; other users can't read jobs or artifacts.
5. Integrate Track B: set `EVAL_SERVICES=real` once `packages/core/src/evals/index.ts` exports `evalServices`; switch `getEvalServices()` to a static import.
6. Switch `STRIPE_MODE=live` with the live key after step 4 passes → first real customer.
7. Expert network phase 2: Google Calendar booking (Vercel Connect OAuth), consented transcripts.
8. Polish: update the Playwright happy-path selectors to the v2 UI, record a backup demo video, freeze at Nov 8 9:30 AM PT.

## Known issues / decisions to remember

- Neon can't snapshot non-root branches, so per-job "re-run finding" rebuilds simulator state from the frozen suite (`captureDeliverySnapshot` returns null for child branches).
- Neon Realtime requires PG 18 and us-east regions; that's why the project moved.
- Vercel ↔ GitHub link failed (no access to `azoghby/autonomous-evals`). Deploy via CLI.
- `AUTH_DEV_LINKS=1` must never be set in production (anyone could sign in).
- Mock eval services set `jobs.is_mock=true`; they're never counted as revenue or customers.

## Log

- 2026-11-07 ~13:45 PT: cloned, branch `track-a`, Neon + Vercel provisioned, scaffold + contracts + schema, first deploy.
- ~14:00: parallel workers: landing UI, app screens, server/auth, workflow/Stripe/cron, test infra. All merged.
- ~14:05: moved Neon to PG18 us-east-2 (Realtime/Storage/Functions need it). Added expert network scope + MVP. Monid connected.
- ~14:30: AgentMail (`ae-commercial@agentmail.to`, inbound webhook `ep_3LnO5TpiMamhUvPG3Kik5WKeN8n`), Vercel Firewall rate-limit rules (3, live), BotID/analytics/headers, Stripe setup script merged. Differentiators dispatched.
- ~14:15: Neon storage, Neon ops, client/server reconciliation merged. AgentMail key received. UI v2 (calmer + Motion/anime.js) started.
- ~15:35: v3 retheme, /sample, AI gateway, conformance harness merged and pushed. Waiting on e2e pipeline, expert call booking, follow-ups/monitoring crons.
- ~15:55: booking, crons, UI hooks merged; `npm run deploy` → prod Ready. Remaining in flight: e2e pipeline test.
- ~16:20: adapters + e2e merged, prod redeployed. Open: stale-job recovery check in prod, Playwright happy-path selectors for v3, Stripe test key.
- ~16:30: deleted old Neon projects sparkling-frost-08478178 and long-shape-06677281 (owner OK, both empty).
- ~16:45: Stripe test key, webhook, NEON_API_KEY, COMPANY_ADDRESS configured; redeployed. Prod paid-run test in flight.
- ~17:10: Gate 3 passed on prod (Stripe test mode): pay → delivered, duplicate + missed webhook recovery. BotID blocks scripted job creation (Playwright detected) — use a real browser or add a bypass for smoke tests. Stale-job recovery cron, MCP hire flow, report page polish merged.
- ~17:40: prod redeployed (security fixes, MCP hire flow, stale-job recovery, report polish, landing perf 96 / a11y 100, OG/robots/sitemap). UI v4 overhaul (neon.com-inspired precision, keep black/white/blue + rib hero) in flight; brief at docs/DESIGN_V4.md.
- ~18:30: features in flight: red-team pack (packages/core/src/redteam), fix-as-GitHub-PR, x402 agent payments (Base Sepolia testnet), public share link + verified badge + live revenue counter. Schema changes are collected by the orchestrator into one migration. Resumable workflow + stale-job auto-restart merged.
