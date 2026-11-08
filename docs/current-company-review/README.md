# Independent review: combined company integration (parent 17625a2)

**Status: changes requested. Candidate not accepted.** Two Medium payment
defects reproduce against the exact composed source. Neither leaks money or
authority beyond the existing job/role/company budget caps. Nothing Critical or
High reproduced. Calendar durable identity, shared paid authority, workflow
continuity, no-redispatch fences, canonical payment binding and held unknown
costs all held under real source and real local SQL.

Scope reviewed: `docs/current-company-composition/{README.md,CANDIDATE.json,stage.mjs,TEST-PIN.json,test-compatibility.patch}`
and the composed candidate. Machine-readable results are in [FINDINGS.json](FINDINGS.json).
Scope detail is in [children/authorization-payment.md](children/authorization-payment.md)
and [children/replay-verification.md](children/replay-verification.md).

## Source checks done before reading

- `/private/tmp/track-b-company-reproduced-20261107` (exact applied candidate):
  2,041/2,041 recorded files match on size and SHA-256. Its `COMPANY-COMPOSITION.json`
  is byte-identical to `CANDIDATE.json` (`d191f8c9…81ca25`).
- `/private/tmp/track-b-company-composed-y74pmmb8` (tested candidate): 2,041/2,041
  match, both at the start and at the end of the review. It also holds 97 unrecorded
  files, all identical to this checkout, and harness files. Next/Workflow build outputs
  appeared there during the review (another process). This review only read its
  `node_modules`, never wrote to it.

## Findings

| ID | Severity | Summary | Repro (fails today) | Fix owner | Status |
|---|---|---|---|---|---|
| F1 (AP-1 = RV-1) | Medium | Refund/cancel outbox rows are never marked delivered, so the bounded scheduler drain (first 25 jobs by tenant/job order) starves later customers' receipts. | `authorization-payment/findings.test.ts` "AP-1…"; `replay-verification/receipt-drain-starvation.repro.test.ts` "RV-1…" | Payment/startup artifact owner | Not accepted |
| F2 (AP-2) | Medium | A signed refund/cancel ingested mid-evaluation does not stop the remaining paid target calls of that evaluation. | `authorization-payment/findings.test.ts` "AP-2…" | Track B release guard + payment/startup owner | Not accepted |
| F3 (RV-2) | Low | The 164-test result is not hash-bound to 7 of its 23 test files, their docs fixture inputs, or the vitest/tsconfig harness. `stage.mjs` output alone cannot rerun it. | Inventory check (below) | Composition owner | Open |
| F4 | Low | `test-compatibility.patch` replaced the real-factory Calendar "refuse before branch/target/reservation" test with a config-only check. The new Calendar success test is fully mocked. | Coverage restored by `replay-verification/{calendar-identity,current-app-calendar}.invariants.test.ts` (pass) | Composition owner (adopt the restored tests) | Coverage restored by review; adopt |
| RV-3 | Info | `bridge.test.ts` imports the docs postimage, not `@/server/current-payment`. The bytes are identical today. | — | Payment/startup owner | Info |
| RV-4 | Info | The per-isolate startup cache keeps a resolved `blocked` or `ready` until the isolate ends; only a rejection is retried. No principal or authority is cached. | `replay-verification/startup.characterization.test.ts` | Owner-loader integrator | Characterization |

### F1: refunds starve the receipt drain (Medium)

- **Cause:**
  - `publish_receipt` returns `waiting_or_revoked` before the outbox
    acknowledgement (`docs/current-autonomy-payment-startup/sql/001-current-payment.sql:127`;
    the ack is only at `:131`).
  - `drainPendingReceipts` selects
    `DISTINCT tenant_id,job_id … WHERE NOT o.delivered ORDER BY ev.tenant_id,ev.job_id LIMIT 25`
    and swallows per-job errors (`apps/web/src/server/current-payment.ts:161-171`).
  - The drain runs before every scheduler tick (`current-payment-startup.ts:69-72`).
- **Effect:** once 25 jobs with permanently undeliverable rows sort ahead of a job,
  that job's post-bootstrap receipt is never published. The customer stays in
  `payment_wait`. Terminal jobs whose drain throws hold slots the same way. This
  contradicts `startup/HANDOFF.md`: "receipts arriving after bootstrap do not stall
  indefinitely".
- **Prerequisites:** 25 refunded/cancelled (or terminal) jobs with earlier-sorting
  IDs. Refunds accumulate in normal operation.
- **Severity reasoning:** fails closed. A per-job bootstrap re-POST drains the victim.
- **Observed:**
  - AP-1: `expected [ 'waiting', 'waiting', 'paid' ] to deeply equal [ 'paid', 'paid', 'paid' ]`.
    The third value is the control: a direct per-job drain works.
  - RV-1: no `payment_receipts` row after 5 ticks.
  - Control: with 24 stuck jobs, the receipt publishes on tick 1
    (`receipt-drain.characterization.test.ts`).
- **Fix:**
  - Give rows that can never publish a terminal outbox state: applied
    refund/cancel rows, and paid rows whose binding is revoked.
  - Make the drain fair, for example oldest-undelivered first with a per-job
    retry-after, instead of lexical tenant order.
  - Files: `docs/current-autonomy-payment-startup/sql/001-current-payment.sql`
    and the bridge `current-payment.ts`.

### F2: a refund does not fence an evaluation already running (Medium)

- **Cause:**
  - Refund ingestion correctly unsettles the receipt
    (`receipt_valid=false`, `settled=false`).
  - The paid guard runs before and after every dispatch (`autonomous-paid.ts:104,118-120`),
    via `apps/web/src/server/autonomy-release.ts:81-84` → `current()` at `:63-76`.
    It re-checks the release binding, policy, paid policy, canonical request and job
    authorization, but never payment validity.
  - Payment is checked once per scheduler pass, before `evaluate`
    (`packages/core/src/agents/autonomy/company.ts:75-76`).
- **Effect:** every remaining Text/Calendar/judge target call in that evaluation
  still goes out after the refund is durably recorded. Spend stays bounded by the
  pinned reservations.
- **Prerequisites:** an operator refund or PaymentIntent cancellation, signed and
  ingested while an evaluation runs.
- **Repro scope:** only the evaluator body is scripted, to inject the refund
  between two dispatches. The startup composition, release server, paid context,
  `runAutonomousTarget`, Stripe ingest path and all SQL are real.
- **Observed:** `expected 'second_dispatch_allowed' to match /^second_dispatch_refused/`.
  The transport was called twice.
- **Not the documented gate:** the payment README's "revocation races" caveat covers
  concurrency. This is deterministic and sequential.
- **Fix:** add a payment-authority check to `guard()`, for example a
  startup-supplied `paymentStillValid(request)` that runs `receipt_valid` for the
  bound quote.

### F3: reproduction completeness (Low)

- **What is pinned:**
  - 16 of the 23 tested files are in the 2,041 recorded hashes, including the 4
    `TEST-PIN.json` postimages.
  - The payment migration SQL is pinned separately in
    `docs/current-autonomy-payment-startup/FILES.json`.
- **What is not pinned:**
  - 7 test files: `current-autonomy-integration/{data-dispatch,release-capability}`,
    `current-autonomy-calendar/calendar`,
    `current-autonomy-payment-startup/{bridge,composition,startup-webhook,startup}`.
  - The docs fixtures they read: owner-migration DDL and the payment/startup tree.
  - The combined vitest/tsconfig harness, which exists only in the tested temp directory.
- **Not in the 164:**
  - `current-autonomy-payment-startup/sql.test.mjs` (the include pattern is `*.test.ts`).
  - The private chat-mount tests (`tests/track-b/current-chat-mount`).
- **Fix:** pin the executed test, fixture and harness hashes in `RESULTS.json`/`TEST-PIN.json`,
  or commit the harness. Name the chat-mount and native-SQL runs separately.

### F4: test-compatibility audit (Low)

| Hunk | Verdict |
|---|---|
| Fixture `try/catch` in both baseline files | Strengthened: on failure it asserts 0 reservations and no `run`/`send`. |
| Removed baseline "Calendar … refuses … before branch/target access" (×2) | Partly lost. The replacement tests only `DATABASE_URL=''`. `calendar.test.ts` has no never-authorized case with reservation or branch-lookup assertions. Restored by `calendar-identity.invariants.test.ts` tests 1–2 (real factory, real SQL, paid authority: 0 branch lookups, pools, reservations, operations and target calls). |
| current-app "Calendar blocked" → "passes guarded Calendar …" | The old refusal is obsolete now that Calendar is supported. The new success test mocks `deps.rich` and `evaluateWithServices`, and the missing-binding test drops `contextFor`-not-called. Non-mocked coverage added in `current-app-calendar.invariants.test.ts`: real `evaluate` → real rich services → real Calendar engine and SQL, replay with no target calls, a rebound run id refused, and a missing binding refused before `contextFor`. |
| registration error code | Rename only; same meaning. |
| `current-autonomy-baseline-correction/owner.patch` | Adds a mock export and removes the runner exclusion. No assertion removed. |

## Confirmed invariants (passing; real source and SQL, only provider/network boundaries scripted)

- **Owner/session revocation:**
  - after an ownership transfer, the old owner gets 404 and the new owner 409;
  - revoked authorization and a cancelled job both give 409;
  - a session revoked between read and respond gives 401, so the publication
    reauthorization patch 0002 survived composition;
  - the scheduler's report notification is refused after a transfer;
  - a transfer, revocation, cancellation or disabled binding fences the next paid call.
- **Shared paid authority:**
  - mismatched release and payment SQL adapters are refused at startup;
  - the paid guard refuses a foreign SQL port;
  - Calendar refuses a paid capability over any SQL port other than `workflowSql()`;
  - revocation mid-Calendar run stops all further target calls, and the held cost stays held.
- **Durable Calendar identity:**
  - scheduler, empty or UUID run ids never authorize paid work;
  - `completeRound` refuses 15 forged identities with 0 reservations and 0 target calls;
  - replaying the same identity, or a version-label collision, is refused without a re-send;
  - investigation gets its own deterministic scope;
  - there is no legacy scenario fallback;
  - paid reruns without identity throw before any target work.
- **No ambiguous redispatch:**
  - a worker lost mid-baseline or mid-investigation leaves the whole phase held
    after reconstruction, with 0 new target calls;
  - a single lost reply is recorded as infrastructure, never reproduced, and the
    phase replays from SQL with 0 calls.
- **Workflow continuity:**
  - `evaluate` uses the job's existing `workflowRunId`;
  - a later run-id change conflicts instead of starting new paid work.
- **Startup per-isolate:**
  - each bootstrap re-resolves the viewer and drains under the caller's own tenant;
  - a rejected load is not cached, and concurrent callers share one load;
  - the scheduler drains before every tick.
- **Canonical payment binding:**
  - an altered amount, currency, PaymentIntent, quote version, job ID, client
    reference, livemode, environment or payment status is refused, leaving no
    retained event or outbox row;
  - payment-row drift, a configured-mode mismatch and an altered duplicate event
    identity are rejected;
  - refund or cancel is still recorded after authority is revoked, the job is
    cancelled or the session is gone, and restoring access cannot revive the receipt;
  - a refund arriving before the paid event never yields paid;
  - per-finding, subscription and USDC payments are refused explicitly.
- **Held unknown costs:**
  - scripted target replies never settle, and unverified receipts are refused;
  - reservations stay held at the pinned job cap, and a raised cap is refused.

## Characterizations (current behavior; not acceptance)

These live in `*.characterization.test.ts` and all pass:

- **Ownership change during a refund:** a refund arriving while job ownership
  differs is refused and not retained.
- **Refunded receipts:** after a refund, the company port reports `waiting`, not `invalid`.
- **Disputes:** `charge.dispute.created` is ignored.
- **Redeliveries:** an event that differs only in `pending_webhooks` is rejected as an identity conflict.
- **Delivered jobs:** a completed autonomous publication returns 409 once the job is `delivered`.
- **Identity hook:** `completeRound` checks self-consistency but does not read the
  checkpoint itself. It is not caller-reachable.
- **Startup cache (RV-4):** see the findings table above.
- **Drain control:** the RV-1 control and the re-selected refund row.

## Known gates (not re-reported)

These were respected as documented gates, not new findings:

- the fail-closed owner adapters;
- exclusive dispatch between legacy `resumeJobForPayment` and the autonomous scheduler;
- no hosted Workflow replay;
- PGlite instead of independent PostgreSQL contention;
- provider attestation;
- adoption of the historical parent onto current main;
- no combined Next build.

## Verification (exact)

Run from the repo root. `run.mjs` hash-checks the reproduced candidate, copies it
into a fresh temp stage with this checkout's supplemental parent tests and docs
fixtures, links the tested candidate's `node_modules` (ipaddr.js 2.5), and blocks
outbound sockets.

```sh
node tests/track-b/current-company-review/run.mjs --baseline
# parent selection only: Test Files 23 passed (23); Tests 164 passed (164); exit 0  (before review tests existed)
node tests/track-b/current-company-review/run.mjs --typecheck --baseline
# {"typecheck":0}; Test Files 2 failed | 33 passed (35); Tests 3 failed | 218 passed (221); exit 1
```

- The 3 failures are exactly the intended repros: AP-1, AP-2 and RV-1.
- The other 218 are the parent's 164 plus 54 review invariants and characterizations.
- Per-scope runs:
  - authorization-payment: 37 tests, 2 failed (AP-1, AP-2).
  - replay-verification: 20 tests, 1 failed (RV-1).
- These review tests are outside the root `vitest.config.ts` include, so root `npm test` is unaffected.
- Root `npx tsc -p apps/web` and `npm test` were not run: this worktree has no
  installed dependencies, installs are out of scope, and no app/core file changed.

Not verified: real Stripe delivery and retries, hosted Workflow crash/replay,
real PostgreSQL contention, real owner adapters, the private chat route's
per-request reauthorization beyond the publication path (read only), a combined
Next build, and current-main adoption.

Log: 2026-11-07. Root LEDGER.md was left untouched because this task's ownership
is restricted to `docs/current-company-review/**` and `tests/track-b/current-company-review/**`.
