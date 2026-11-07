# Track A: implementation plan (app, platform, payments, deploy)

Extends [PLAN.md](../PLAN.md) and [TRACKS.md](../TRACKS.md). This file records the decisions Track A made while building, so Track B and future sessions don't have to work them out again.

## 0. Provisioned infrastructure (done Nov 7)

| Resource | Value |
|---|---|
| Vercel project | `autonomous-evals` (team `agents`), root dir `apps/web`, prod URL https://autonomous-evals.vercel.app |
| Neon project | `autonomous-evals` `sparkling-frost-08478178`, us-west-2, PG 17, db `app` |
| Neon branches | `main` (app DB, migrated), `sim-seed` `br-steep-haze-bf5cxtyn` (Track B simulator seed; no compute yet: add one when seeding) |
| Blob | private store `autonomous-evals-artifacts` (pdx1), `BLOB_READ_WRITE_TOKEN` on all envs |
| Env on Vercel | `DATABASE_URL(_UNPOOLED)`, `SESSION_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `CRON_SECRET`, `OPERATOR_EMAILS`, `STRIPE_MODE=test`, `BLOB_READ_WRITE_TOKEN` |
| Missing (needs a human) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY` + `EMAIL_FROM`, `NAIVE_API_KEY`, `NEON_API_KEY` (Track B branching) |

AI Gateway: on Vercel, the OIDC token authenticates automatically. Locally, Track B needs `AI_GATEWAY_API_KEY` or `vercel env pull`.

## 1. Repository layout

```
apps/web/                     Next.js 16 App Router (Vercel root)
  src/app/page.tsx            landing ("Agents build your evals")
  src/app/(app)/              signin, start (intake), jobs, jobs/[id], operator
  src/app/api/                auth, jobs, operator, stripe/webhook, cron/*
  src/server/                 session, queries, job-store, services (mock|real), idempotency
  src/workflows/              events.ts (start + resume), job.ts (jobWorkflow), steps/
  src/components/{ui,marketing,app}/
packages/core/src/
  contracts/                  Zod contracts + EvalServices interface (shared A↔B)
  db/                         Drizzle schema + migrations (A), client
  auth/ storage/ payments/    Track A
  agents/ evals/ targets/ simulator/ reporting/   Track B
```

## 2. Decisions beyond the original plan

1. **One hook per job, opened at start.** `start(jobWorkflow, [jobId], { experimental_hook: { token: "job:<id>" } })`. Every external input (`clarification_answer`, `quote_accepted`, `payment_confirmed`, `cancel`) goes through `resumeHook` on that token. The hook exists from admission, so a Stripe webhook that arrives before the workflow reaches its payment wait is buffered, not lost. Duplicate `start` calls throw `HookConflictError`, which gives us run idempotency.
2. **Payment exactly-once comes from three layers.**
   - (a) `payments` is unique on `stripe_checkout_session_id` and `stripe_event_id`. The insert uses `ON CONFLICT DO NOTHING`.
   - (b) The row is written *before* the webhook returns 200. `workflow_resumed_at` is set only after `resumeHook` succeeds. Cron re-resumes rows where it is null.
   - (c) The workflow ignores a `payment_confirmed` whose quote version is stale, or that arrives when the job is already past `awaiting_payment`. `resumeHook` alone is at-least-once (per the Workflow docs), so (c) is required.
3. **Cleanup deadlines are columns, not sleeps.** `credentials_delete_after = delivered + 24h` and `branch_delete_after = delivered + 48h` are written at delivery. The hourly cleanup cron enforces each one on its own.
4. **Price never comes from an agent.** The Commercial agent returns a `QualifyResult` (package plus scope). `createQuote` takes the price from `PRICE_CENTS`.
5. **Mock services are explicit.** `getEvalServices()` returns mocks unless `EVAL_SERVICES=real`. Mock jobs set `jobs.is_mock = true` and are excluded from revenue and customer counts.
6. **Live/test separation.** `STRIPE_MODE` decides the job's `environment`. The Stripe client refuses keys whose prefix doesn't match the mode. Console revenue counts `environment = 'live'` payments only.
7. **Credentials.** API keys are removed from `intake` at submit time and stored AES-256-GCM-encrypted in `job_credentials`. They are decrypted only inside workflow steps that call the target, and never passed to agents or logs.
8. **Ownership.** Every job read goes through `getJobForViewer`. A job someone else owns returns 404 (not 403), so existence doesn't leak. Artifact downloads stream from the private Blob store through that same check. Blob URLs are never handed out.

## 3. Job state machine (as implemented)

```
draft → (qualify) → needs_clarification ⟲ (≤3 rounds) → quoted → awaiting_payment
      → planning → [trace_audit: auditTrace] | [others: branch → designSuite → runSuite → investigate]
      → renderReport → Blob → delivered → (cron) creds −24h, branch −48h
side exits: paused_budget (reservation exceeded), failed (FatalError), cancelled, payment_review
```

## 4. API surface (frozen for the screens)

| Method | Path | Notes |
|---|---|---|
| POST | /api/auth/request-link | `{email}` → `{ok, devLink?}` (devLink only without Resend / in dev) |
| GET | /api/auth/verify | `?token&next` (relative `next` only) |
| POST | /api/jobs | `Idempotency-Key` header, `IntakeInput` → `201 {jobId}` |
| GET | /api/jobs, /api/jobs/:id, /api/jobs/:id/progress | owner or operator |
| POST | /api/jobs/:id/messages | `{answer}`; 409 unless `needs_clarification` |
| POST | /api/jobs/:id/accept-quote | `{quoteVersion}` → `{checkoutUrl}` |
| POST | /api/jobs/:id/findings/:fid/rerun | new finding linked via `rerun_of_finding_id` |
| POST | /api/jobs/:id/retest | linked job → `{jobId}` |
| POST | /api/jobs/:id/monitoring | subscription checkout → `{checkoutUrl}` |
| GET | /api/jobs/:id/artifacts/:kind | `report`, `suite` or `evidence`, streamed |
| POST | /api/stripe/webhook | signature verified |
| GET | /api/cron/{reconcile-payments,stale-jobs,cleanup,monitoring,follow-ups} | `Bearer CRON_SECRET` |
| GET/POST | /api/operator/{overview,interventions,outreach/:id/(approve|reject)} | operator allowlist |

## 5. Track B integration points

- Implement `EvalServices` (`packages/core/src/contracts/services.ts`) and export it from `packages/core/src/evals/index.ts`. Then set `EVAL_SERVICES=real`.
- Use the `ServiceContext` passed in to record costs and progress. Don't write to app tables directly.
- Simulator migrations go under `packages/core/src/simulator/migrations/`. Apply them to `sim-seed` only.
- Dependencies: ask Track A to install them (one lockfile).

## 6. Gate checklist (Track A side)

- [x] Deployed URL; Neon migrated; Blob + env wired
- [ ] Auth + intake + job page on prod (mock services)
- [ ] Unpaid mock Trace Audit delivered through the real Workflow on Vercel
- [ ] Stripe test keys → paid Trace Audit; duplicate/missed webhook tests pass
- [ ] Redeploy mid-job resumes; no duplicate sessions
- [ ] Must-pass security/budget checks (PLAN §9) → `STRIPE_MODE=live`

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Vercel GitHub app can't access `azoghby/autonomous-evals` (link failed) | Deploy via CLI for now. Repo owner installs the Vercel GitHub app for preview deploys. |
| No email provider before customers arrive | Dev links are allowed only behind `AUTH_DEV_LINKS=1`, never on in prod. Get a Resend key first. |
| Workflow v5 APIs are new | Kept the hook/start pattern in one file (`workflows/events.ts`). Tests cover the decision logic as pure functions. |
| Contract drift between A and B | All contract edits go through `packages/core/src/contracts/*`, agreed first. |

## Artifacts on Neon storage

Job artifacts (report, suite, evidence) are written to a **private bucket `artifacts` on Neon branchable object storage** (S3-compatible, project `icy-star-64097833`, main branch). Vercel Blob remains as a fallback.

**Why.** Neon buckets branch with the database (copy-on-write). A per-job branch or snapshot therefore captures the evidence files and the database state together, so a finding can be reproduced from one consistent point. Resetting a branch from its parent resets its objects as well.

**How it works.** `packages/core/src/storage/neon-storage.ts` does put/get(stream)/delete for keys `jobs/<jobId>/<kind>-<rand>.<ext>`. `blob.ts` keeps the same exported functions and picks the backend with `ARTIFACT_STORE=neon|blob` (default: neon when all `NEON_STORAGE_*` are set, else blob). Persisted pathnames are prefixed `neon:` or `blob:`; unprefixed legacy values are read as Blob, so old and new artifacts both resolve.

**Security.**
- Bucket is `private`; the only way in is an S3 credential held server-side (`NEON_STORAGE_ACCESS_KEY_ID` / `NEON_STORAGE_SECRET_ACCESS_KEY`, a dedicated `storage:read`+`storage:write` credential, branch-scoped to main and descendants). Secrets live only in env (local `.env`, Vercel). Revoke or rotate from the Neon Console or CLI.
- Downloads go through `/api/jobs/:id/artifacts/:kind`: session check, then `getJobForViewer` ownership (404 on mismatch), then the server streams the object. No storage URL is returned to clients. `neonPresignGet` exists (capped at 60s) but is not used by any route.
- Keys are validated against `jobs/<id>/<file>` before any S3 call, so a stored pathname cannot traverse to other objects.
