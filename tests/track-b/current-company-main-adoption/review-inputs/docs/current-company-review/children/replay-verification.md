# Replay / verification child review

Scope: replay, durable identity, startup recovery, redispatch, test completeness and reproduction for the composed company candidate `/private/tmp/track-b-company-reproduced-20261107` (2,041 recorded files; its `COMPANY-COMPOSITION.json` is byte-identical to `docs/current-company-composition/CANDIDATE.json`, sha256 `d191f8c9…81ca25`). Tests live in `tests/track-b/current-company-review/replay-verification/`. They run against hash-checked candidate source via the integrator's `run.mjs`, using PGlite SQL and an outbound-socket guard. Scripted boundaries: Neon Pool transport, canonical job loader, branch connection lookup, target HTTP, and Stripe signature verification (verified events enter at the SQL `ingest_event` boundary). No network, secrets, providers, or deploys were used.

## Findings

| ID | Title | Severity | Prerequisites | Composed source | Repro | Fix owner / path | Acceptance |
|---|---|---|---|---|---|---|---|
| RV-1 | Scheduler receipt drain starves behind permanently undeliverable outbox rows | Medium (liveness; fails closed, no money/authority leak) | ≥25 jobs whose tenant/job sorts earlier and that hold an undelivered outbox row that can never become deliverable. Examples: any refund/cancel event (publish returns `waiting_or_revoked` and never sets `delivered`), or a job that later became terminal (drain throws, then `blocked`). These rows build up over normal operation. | `apps/web/src/server/current-payment.ts:161-171`: `SELECT DISTINCT … WHERE NOT o.delivered ORDER BY tenant_id,job_id LIMIT $1` with limit 25, and blocked jobs are swallowed at `:169`. `docs/current-autonomy-payment-startup/sql/001-current-payment.sql:127`: `waiting_or_revoked` leaves the outbox undelivered. Called on every tick from `apps/web/src/server/current-payment-startup.ts:71`. | `receipt-drain-starvation.repro.test.ts` › "RV-1: a receipt arriving after bootstrap is eventually drained…". **FAILS today**: `expected false to be true` (no `company_autonomy_release.payment_receipts` row after 5 ticks). Control in `receipt-drain.characterization.test.ts`: with 24 stuck jobs the same receipt publishes on tick 1. | Payment/startup artifact owner: `docs/current-autonomy-payment-startup/bridge/source/apps/web/src/server/current-payment.ts` and `sql/001-current-payment.sql`. Options: give revoked/refund events a terminal non-pending outbox state; or use a fair cursor/backoff so blocked jobs don't keep their window slot. | Contradicts HANDOFF.md ("receipts arriving after bootstrap do not stall indefinitely"). Workaround: the owner re-POSTs bootstrap, which drains per job. Same defect independently reported by the sibling child as AP-1 (`authorization-payment/findings.test.ts`). |
| RV-2 | Combined result is not hash-bound to the tests and fixtures that produced it | Low (reproduction) | — | `docs/current-company-composition/stage.mjs` outputs source only. The `combined-vitest.config.mjs` / `tsconfig.combined-tests.json` exist only in `/private/tmp/track-b-company-composed-y74pmmb8` and are not committed. | Inventory analysis (see Reproduction). | Composition owner: record the hashes of the test files and fixtures that were run, plus the harness config, in `RESULTS.json`/`TEST-PIN.json`, or commit the harness. | Open. |
| RV-3 | `bridge.test.ts` imports the docs postimage, not composed source | Info | — | `tests/track-b/current-autonomy-payment-startup/bridge.test.ts:2` imports `docs/current-autonomy-payment-startup/bridge/source/…/current-payment.ts`. | The bytes are identical today (sha256 `ef6752a3…bf5c18c` in both places), so there is no impact yet. | Payment/startup owner: import `@/server/current-payment`. | Informational. |
| RV-4 | Isolate startup caches a resolved `blocked` status and a resolved `ready` startup for the isolate's lifetime | Low / Info | The loader's answer changes inside one isolate. The shipped loader is static, so this does not happen today. | `apps/web/src/server/current-payment-startup.ts:86-88`: only a rejection is cleared. | `startup.characterization.test.ts` (2 passing). No principal or authority is cached: see invariants below. | Owner-loader integrator: document that the loader answer must be static configuration, or cache only `ready`. | Characterization, not a defect claim. |

No caller-visible exploit was found in Calendar identity, workflow continuity, or the redispatch fences.

## Test-patch hunk audit (`test-compatibility.patch`)

| Hunk | Removed or changed assertion | Where it is preserved, or lost |
|---|---|---|
| acceptance-baseline / current-baseline fixture (×2) | None removed. A catch is added: on construction failure it asserts 0 reservations and that neither `run` nor `send` was called, then rethrows. | Strengthened. |
| acceptance-baseline / current-baseline (×2): removed "actual Calendar autonomous factory refuses unsupported lifecycle identity before branch/target access" | The old test used the real factory, real SQL and paid authority. It asserted that `freezeSuite` rejects with: no legacy bootstrap, no target send, 0 reservations. | **Partly lost in the parent suite.** The replacement only checks `DATABASE_URL=''`, which is a configuration refusal. The new fixture catch still covers no-send, no-bootstrap and 0 reservations, but only for that configuration error. `calendar.test.ts` only covers identity changes after a successful run, with call counts; it has no reservation or branch-lookup assertions and no never-authorized case. **Restored by this review**: `calendar-identity.invariants.test.ts` tests 1–2. With a configured application DB and paid authority, (a) a SQL port that is not exactly `workflowSql()` and (b) the removed fixture's shape (no reviewed suite) both refuse with 0 branch lookups, 0 simulator pools, 0 reservations, 0 paid operations and 0 target calls. |
| current-app: removed "keeps autonomous Calendar explicitly blocked…" | Refusal `autonomous_calendar_durable_run_identity_required`, with `contextFor`, `rich` and `evaluateWithServices` all not called. | Intentionally obsolete, since Calendar is now supported. "No construction without identity" survives in the new missing-binding test, but that test drops the `contextFor`-not-called check. The new success test mocks both `deps.rich` and `evaluateWithServices`. **Non-mocked coverage added**: `current-app-calendar.invariants.test.ts` uses the real `createCurrentAutonomyApplication.evaluate` → real `createRichWorkflowServices` → real Calendar engine and SQL. It shows 24 metered reservations, replay with no target calls, refusal of a rebound run id, and that a missing binding refuses before `contextFor`. |
| registration | Error code `owner_composition_unavailable` → `current_autonomy_owner_adapters_unconfigured`. | Same semantics (refuses when owner adapters are not installed). Preserved. |

`docs/current-autonomy-baseline-correction/owner.patch` only adds a mock and removes the runner exclusion. No assertion is removed.

## Reproduction completeness

- Of the 23 test files in the 164-test run, **16 are in the 2,041 recorded hashes**. That includes the 4 postimages from `test-compatibility.patch`, because `stage.mjs` adds every `+++ b/` path to `changed`, and `changed` is part of the final inventory. So the integrator's "none recorded" is refuted.
- **7 are unrecorded**: `current-autonomy-integration/{data-dispatch,release-capability}.test.ts`, `current-autonomy-calendar/calendar.test.ts`, and `current-autonomy-payment-startup/{bridge,composition,startup-webhook,startup}.test.ts`.
- The fixture inputs are also unrecorded: all of `docs/current-autonomy-payment-startup/**` and `docs/current-autonomy-integration/dependencies/owner-migrations/*.sql`. In this checkout the review runner copies 74 unrecorded parent files, plus this review's own files.
- These files are git-tracked at HEAD (`14b73ec`/`17625a2`), but no result artifact binds them by hash.
- The combined vitest/tsconfig harness is not committed.
- `current-autonomy-payment-startup/sql.test.mjs` (native SQL, `node:test`) is **not** among the 164, because the include pattern is `*.test.ts`.
- `tests/track-b/current-chat-mount` is not among the 164 (confirmed).
- **`stage.mjs` alone cannot reproduce the 164.** It copies no unrecorded tests, fixtures, harness, dependencies or offline guard.
- `stage.mjs` does verify the chat-mount input: the sha of `CURRENT-COMPOSITION.json` must equal `docs/current-chat-mount/CANDIDATE.json` `compositionSha256`, and every inventoried file is hash-checked. It does not check for extra unlisted files, but it copies only inventoried files.
- `changed` does include the payment patch paths: all 10 are in the final inventory and CANDIDATE.json.
- Base drift is **not** re-checked after the payment patch. Only the 10 payment postimages are checked against `APPLICATION.json`, and those 10 equal exactly the patch's paths. Because `git apply` touches only the patched paths, there is no practical gap. `stage.mjs` also never compares its output to `CANDIDATE.json`; I did that manually (identical).

## Confirmed invariants (passing, real source + real SQL)

- `calendar-identity.invariants.test.ts` (5 tests):
  - Paid Calendar refuses construction without the exact `workflowSql()` port.
  - A retained binding with no reviewed suite refuses before any branch, simulator or reservation work.
  - Scheduler, empty or UUID run ids never substitute for the job's Workflow run id.
  - The real `completeRound` refuses 15 forged identities with no reservation or target call: generated-UUID run or scope, scheduler run id, scenario-only scope, operation without its run, foreign job/scope/branch, wrong suite hash, unknown phase, round 0/7/1.5, unreviewed scenario, version/scope mismatch.
  - The positive control dispatches once.
  - Replaying the same lifecycle id is refused without a re-send.
  - A baseline/version collision (same run/phase/scenario/round, different `versionLabel`) is refused without a re-send. This is safe, because `dispatchId` excludes the version (`rich-services.ts:181`).
  - Investigation gets a distinct deterministic scope and dispatch.
  - The legacy scenario factory is never a paid fallback.
  - Paid `rerunCalendarFinding`, and investigation without operation identity, throw `calendar_durable_dispatch_identity_required` before any target work.
- `calendar-replay.invariants.test.ts` (3 tests):
  - A worker lost mid-baseline (target never answers) leaves the phase `pending`. Reconstruction refuses run, investigate and report; there are no new target calls, and the in-flight intent stays an unsettled `dispatched` hold.
  - A worker lost after investigation journal intent holds the whole investigation, while the completed baseline still replays from SQL.
  - A single lost reply is recorded as infrastructure, is never reproduced, and the completed phase replays with zero target calls.
- `current-app-calendar.invariants.test.ts` (3 tests): workflow continuity. `evaluate` passes the job's existing `workflowRunId`, not a scheduler run; changing the run id later conflicts with the retained phases instead of minting new paid work.
- `startup.invariants.test.ts` (3 tests):
  - The cached isolate startup holds no principal: each bootstrap re-resolves the viewer and drains under that caller's own tenant, and a missing viewer gets 401.
  - A rejected load is not cached, and concurrent callers share a single load.
  - The scheduler drains before every tick, and a drain failure prevents the tick.
- By source review:
  - Routes (`jobs/[jobId]/autonomy`, `report`, `cron/autonomy`, Stripe webhook) and `advanceDueJobsStep` each call `currentAutonomy()` per invocation; the step has `maxRetries=0`.
  - The legacy `resumeJobForPayment` is preserved after bound ingestion (`stripe/webhook/route.ts:66-72`). Exclusive dispatch between it and the autonomous scheduler is a known documented gate.
  - `runAutonomousTarget` refuses any existing operation id (`autonomous-paid.ts:108-110`).
  - The Calendar `operation()` marks ambiguity and never releases a claim.

## Characterizations (NOT acceptance)

- `calendar-identity.characterization.test.ts`: the app-level `completeRound` hook checks that the identity is self-consistent. It does not itself read a claimed `calendar_run` checkpoint or the investigation journal intent; it relies on the core engine being its only caller. The hook is not reachable through the services API, so this is not caller-visible.
- `startup.characterization.test.ts`: RV-4.
- `receipt-drain.characterization.test.ts`: the RV-1 control, and a refund outbox row that stays undelivered and is re-selected on every tick.

## Commands and results

- `node tests/track-b/current-company-review/run.mjs tests/track-b/current-company-review/replay-verification` → 8 files, 20 tests: **19 passed, 1 failed (RV-1, the intended repro)**. Exit 1.
- `node tests/track-b/current-company-review/run.mjs --baseline tests/track-b/autonomous-company tests/track-b/autonomy-release-adoption tests/track-b/autonomy-paid-app-integration tests/track-b/current-autonomy-integration tests/track-b/current-autonomy-calendar tests/track-b/current-autonomy-payment-startup packages/core/src/evals/calendar-integration tests/track-b/current-company-review/replay-verification` → 31 files, 184 tests: **183 passed, 1 failed (RV-1)**. That is the parent's 23 files / 164 tests passing, plus this review's 20.
- Unfiltered `run.mjs --baseline` (which also picks up the sibling child) → 221 tests, 3 failed: AP-1, AP-2 and RV-1.
- Strict `tsc` (`tsconfig.review-rv.json` written in the temporary review stage, `strict:true`) over `replay-verification/**/*.ts` → exit 0, 0 errors.

## Unverified

- Hosted Workflow replay and OS process kill or restart: lost workers are modelled by a target that never answers.
- Real PostgreSQL contention and advisory locks: the Pool mock ignores advisory locks.
- A real Stripe signature path.
- A combined Next build.
- Owner adapters, and exclusive dispatch between legacy and autonomous evaluation.
- Current-main adoption.
- Whether RV-1's 25-row window is reachable at today's scale.
