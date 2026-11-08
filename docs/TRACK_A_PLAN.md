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
- **New (fix, not just find):** implement `proposeAndVerifyFix(ctx, {finding, suite?, intake}) -> Remediation` (contract `Remediation` in `contracts/index.ts`). The workflow calls it once per confirmed finding (max 5, under the `engineer` budget share) after investigate / auditTrace and before `renderReport`; it must verify the patch by re-running the relevant frozen scenario(s) or trace re-check with the patch applied and fill `verification` (before/after pass counts, regressions, up to 5 evidence items). `renderReport` input now also carries `remediations?: Remediation[]` for a "Validated fixes" section. Results persist in the `remediations` table and are returned as `remediations` by `getJobForViewer`.
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

## Neon Realtime (beta)

The job page and operator console update live over Neon Realtime (project `icy-star-64097833`, branch `main`, database `app`) instead of polling.

**How it is secured.** The browser never gets the signing secret or any way to write SQL.
- `NEON_REALTIME_SECRET` is only read in `apps/web/src/server/realtime.ts` (`server-only`). The browser gets `NEON_REALTIME_URL` plus *sealed queries*: encrypted and signed capabilities for one fixed SQL statement with its parameters baked in, valid for about 60 seconds.
- `GET /api/jobs/:jobId/live` runs the same ownership rule as every job read (decision 8): session required (401), then `canViewJob` (owner or operator), otherwise **404** (a foreign job and a missing job look identical). It only then seals two fixed queries: `progress_events WHERE job_id = $1 ORDER BY created_at` and `jobs WHERE id = $1` (id, state, error, updated_at only; intake and credentials are never selected). The job id is the only parameter and is taken from the authorized row.
- `GET /api/operator/live` is operator-only (401/403) and seals three fixed queries: recent jobs (no intake), payments and interventions, 200 rows each.
- Because the query is sealed, a client cannot change the SQL, the job id or the database, and cannot subscribe to another job. Sealed queries are bearer tokens, so the routes send `Cache-Control: private, no-store`. Subscriptions are renewed by re-calling the route 10 seconds before expiry, so ownership is re-checked about once a minute. Realtime only accepts browser origins on the branch allowlist (`https://autonomous-evals.vercel.app`, `http://localhost:3000`).
- Env: `NEON_REALTIME_URL`, `NEON_REALTIME_SECRET`, optional `NEON_REALTIME_DB` (default `app`), set in `.env.local` and in Vercel (production, preview, development).

**Client and fallback.** `use-live-job.ts` and `use-live-operator.ts` (in `apps/web/src/lib/client/`) share `live-connection.ts`. If realtime has not reached `live` within 5 seconds, or any subscription errors, or the live route fails (for example 503 when unconfigured), the hook falls back to the old behavior: polling `GET /api/jobs/:id/progress` every 3 seconds (operator: reloading `/api/operator/overview` every 5 seconds). The hooks expose `mode: 'live' | 'polling'`, and a blue pulsing "Live" indicator is shown only in `live` mode. The job page still reloads `GET /api/jobs/:id` when the state changes, and the operator console reloads the overview when live rows change, so aggregates (revenue, costs) stay server-computed.

## Design system v3 (black / white / lightning blue)

Supersedes the earlier navy / cream / coral "ribbed glass" UI direction.

**Palette (tokens in `apps/web/src/app/globals.css`).** `--bg #0A0A0B`, `--fg #FFFFFF`, `--muted #A1A1AA`, `--subtle #71717A`, `--line` white at 10% (`--line-strong` 18%), one accent `--accent #2F6BFF` with `--accent-bright #5B8CFF` for hover, glow and focus. Status dots only: `--ok`, `--warn`, `--danger`, muted. Tailwind: `bg-bg`, `text-fg`, `text-muted`, `border-line`, `bg-accent`, `text-accent-bright`.

**Rules.**
- Blue is for primary actions, active states, key numbers, focus rings, live indicators and link hover. Nothing else.
- No pills, no glass or blur cards, no gradient blobs. Buttons and inputs are rectangular with a 6-8px radius. Separate content with hairlines, spacing and type, not boxes.
- Status is dot plus text (`StatusChip`). Findings are flat hairline rows.
- Type: Inter Tight for display and body, JetBrains Mono for labels, numbers and code. Headlines are tight (about -0.04em) and pure white; secondary copy is `#A1A1AA`.
- Hero: full-bleed black, plain-text nav, headline bottom-left, CTA bottom-right, feature row under a hairline. The background is `RibField` (canvas of thin vertical ribbed lines that bend and turn electric blue near the cursor, lerped, paused offscreen, static under reduced motion, drift on touch).
- Motion is kept: anime.js headline stagger, `CountUp`, Motion `Reveal`/`Stagger`/`DrawRule`, sliding nav underline, button press springs, lightning sweep (`.bolt-sweep`) on the primary button. All respect `prefers-reduced-motion`.

**Primitives (`apps/web/src/components/ui`).** `Button` (primary | outline | ghost | quiet), `Surface`, `Chip`/`StatusChip`, `Field`, `TopBar`, `PageShell`, `BlueLight`, `RibField`. The old navy/cream/coral/glass aliases were removed.

### Model access (AI gateways)

Track B gets every model call through `packages/core/src/ai/gateway.ts`; do not instantiate provider SDKs elsewhere.

```ts
import { generateStructured, generateText, GatewayError } from "@ae/core/ai/gateway";
import { z } from "zod";

const Verdict = z.object({ pass: z.boolean(), reason: z.string() });
const { object, microUsd } = await generateStructured({
  model: "sonnet",            // "haiku" | "sonnet" | "opus" (packages/core/src/ai/models.ts) or a ModelSpec
  system: rubric,
  prompt: transcript,
  schema: Verdict,
  ctx,                        // a ServiceContext: needs recordCost() and (optionally) budgetMicroUsd
  agent: "judge",             // CostEntry.agent
  maxOutputTokens: 600,
  timeoutMs: 45_000,
});
```

- **Providers.** Vercel AI Gateway first (`anthropic/claude-sonnet-5.5`, `anthropic/claude-haiku-5.5`, `anthropic/claude-opus-5.5`; auth is OIDC on Vercel, `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` locally). On 429, 5xx, timeout, 401/402/403 or a missing config it falls back to the Neon AI Gateway (OpenAI-compatible `${NEON_AI_GATEWAY_URL}/v1`, ids `claude-sonnet-5-5` etc., credential `NEON_AI_GATEWAY_KEY`). A 400-class error is not retried elsewhere. Pass `providers: ["neon"]` to pin one.
- **Cost.** Every successful call (even one whose output later fails validation) calls `ctx.recordCost({source:"ai_gateway", agent, microUsd, meta:{provider, model, inputTokens, outputTokens, costBasis}})`. Vercel reports cost in `providerMetadata.gateway.cost` (`costBasis: "gateway_reported"`); Neon reports none, so we record the list-price estimate (`"list_price_estimate"`; Neon inference is currently free in preview, so this overstates). If `ctx.budgetMicroUsd <= 0` the call is refused (`budget_exhausted`).
- **Structured output.** `generateStructured` appends the zod JSON Schema to the system prompt, extracts the first JSON value (fences tolerated) and validates with the schema. Malformed output throws `GatewayError` with `code: "malformed_output"` (raw text in `details.raw`); it is never coerced or silently retried. Callers decide whether to re-ask.
- **Errors.** `GatewayError.code`: `credential_leak | malformed_output | all_providers_failed | budget_exhausted | not_configured`.
- **Never send customer credentials.** `assertNoCredentials` rejects prompts/system text that look like API keys, bearer tokens, AWS/Google/GitHub/Slack/Stripe/Neon keys or private keys. Redact before calling; customer secrets must never reach a model.
- **Smoke:** `npx tsx scripts/ai-smoke.ts` runs one tiny structured call through each provider and prints provider, model, latency, micro-USD.
- **Env:** `AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN`, `NEON_AI_GATEWAY_URL`, `NEON_AI_GATEWAY_KEY` (the Neon pair is set on Vercel production/preview/development).
