# Company review child: authorization / payment

Scope: cross-service authorization and payment boundaries in the hash-verified composed candidate
`/private/tmp/track-b-company-reproduced-20261107` (2,041 files, `docs/current-company-composition/CANDIDATE.json`).
The payment SQL (`docs/current-autonomy-payment-startup/sql/001-current-payment.sql`) is not in the candidate inventory;
the runner copies it from this checkout into the stage, so SQL line numbers below refer to that file.

Tests use the real modules `current-payment-startup`, `current-payment`, `current-stripe-payment`, `current-autonomy`,
`autonomy-release`, `autonomous-paid` and `rich-services`/core Calendar. Persistence is actual PostgreSQL SQL in PGlite:
app baseline 0000+0006, release schema, paid-authority column, payment migration, paid operations, and agent-persistence ledger.
Only these boundaries are scripted: the Stripe SDK `constructEvent`, the session viewer, the target transport, the
branch connection, and the `advanceAutonomousCompany` driver. The driver calls the real `CompanyPorts` returned by the release server.

## Findings

### AP-1: Revocation outbox rows are never acknowledged and starve the bounded scheduler drain (Medium)
- **Defect:** `publish_receipt` returns `waiting_or_revoked` without setting `delivered`
  (`001-current-payment.sql:127`, ack only at `:131`). So every refund/cancel event row stays undelivered forever.
  Paid rows for revoked, never-bootstrapped or terminal jobs also stay undelivered. `drainPendingReceipts` selects
  `DISTINCT tenant_id,job_id ... WHERE NOT o.delivered ORDER BY ev.tenant_id,ev.job_id LIMIT 25`
  (`apps/web/src/server/current-payment.ts:161-171`). Once 25 such jobs sort first, the scheduler drain
  (`current-payment-startup.ts:69-72`) never reaches any later job. A customer who paid after bootstrap then stays
  in `payment_wait` indefinitely. This contradicts `startup/HANDOFF.md:15`: "receipts arriving after bootstrap do not stall indefinitely".
- **Prerequisites:** at least 25 jobs with permanently undeliverable outbox rows whose tenant/job IDs sort before the victim's.
  Refunds accumulate in normal operation. The victim's receipt was ingested after its bootstrap. The direction is fail-closed:
  no unauthorized work. Mitigation: re-POSTing bootstrap drains that job specifically.
- **Repro:** `tests/track-b/current-company-review/authorization-payment/findings.test.ts` →
  "AP-1: refunded jobs' permanently undeliverable outbox rows must not starve the bounded scheduler drain of later paid receipts".
  Observed: `expected [ 'waiting', 'waiting', 'paid' ] to deeply equal [ 'paid', 'paid', 'paid' ]`. The 25 refund rows stay undelivered
  (asserted). The third value, `paid`, is the control: after a job-targeted `drainReceipts`, the same receipt is valid.
- **Fix owner / path:** the payment-startup artifact owner. Acknowledge (or move to a terminal state) rows that can never publish:
  refund/cancel rows already applied in `ingest_event`, and paid rows whose binding is revoked. Also make the drain fair, for example
  by ordering on the oldest undelivered row with a per-job retry-after/cursor instead of a lexical `tenant_id` order.
- **Acceptance:** not accepted.

### AP-2: A signed refund/cancellation does not fence in-flight paid dispatch (Medium)
- **Defect:** refund/cancel ingestion revokes the binding and unsettles receipts (`current-payment.ts:117-146`,
  `001-current-payment.sql:82-88`). But the paid guard re-checked before and after every dispatch only covers the release binding,
  policy, paid policy, canonical request and job authorization (`apps/web/src/server/autonomy-release.ts:81-84`; used by
  `autonomous-paid.ts:104,118-120`). It never re-reads `receipt_valid`/payment state. The payment gate is checked once per tick
  (`packages/core/src/agents/autonomy/company.ts:75-76`), before `evaluate`. Inside one evaluation, every remaining
  Text/Calendar/judge target call therefore proceeds after the refund is durably recorded.
- **Prerequisites:** an operator refund (or PaymentIntent cancel) signed and ingested while an evaluation is running.
  Spend stays bounded by the pinned job/role/root reservations.
- **Repro:** `findings.test.ts` → "AP-2: a signed refund recorded during an in-flight evaluation must fence the remaining paid
  target dispatches". Before the second dispatch, the test asserts the refund was `queued`, `receipt_valid=false`, and the receipt
  `settled=false`. Observed: `expected 'second_dispatch_allowed' to match /^second_dispatch_refused/`. The transport is called twice.
- **Fix owner / path:** Track B (release guard) with the payment-startup artifact owner. Add a payment-authority check to the guard,
  for example a startup-supplied `paymentStillValid(request)` that runs `receipt_valid` for the bound quote, or a revoked-binding
  check, invoked by `guard()`.
- **Acceptance:** not accepted.

No Critical/High defect was reproduced. Known gates were not re-reported as findings: fail-closed owner adapters,
legacy-vs-autonomous exclusive dispatch, hosted Workflow, independent-connection contention, provider attestation, and current-main adoption.

## Confirmed invariants (passing)
These are in `composed.invariants.test.ts` unless noted.
- **Publication / owner revocation:**
  - "job ownership transfer: old owner 404, new owner 409; payload never serialized"
  - "current target/policy authorization revoked: 409 without payload"
  - "cancelled canonical job: 409 without payload"
  - "session revoked after the durable read but before serialization: 401 (publication reauthorization patch present)". This confirms patch 0002 survives composition.
  - "scheduler report notification is refused after ownership transfer; owner outbox never called"
- **Paid dispatch:**
  - "%s mid-evaluation refuses the next paid target call and leaves its reservation unspent", run for ownership transfer, authorization revoked, job cancelled and release binding disabled. Each time: one transport call and only `op-1` retained.
  - "startup refuses distinct release and payment SQL adapters; paid guard refuses a foreign SQL port"
- **Calendar** (`calendar.invariants.test.ts`, parent calendar fixture copied verbatim):
  - "Calendar refuses a paid capability minted over any SQL adapter other than the application workflowSql() port, before any target call". The positive control with the identical port constructs.
  - "revocation during a Calendar run stops every further paid target call; only the in-flight intent is retained and its cost stays held". This fixture's guard is the parent's scripted guard; the composed release guard is covered above.
- **Payment binding** (real SQL):
  - "altered %s is refused and retains no event or outbox work", run for amount, currency, PaymentIntent, quote version, job metadata, client reference, object livemode, metadata environment and unpaid status.
  - "canonical payment row drift (amount/status/environment) is refused by SQL/bridge"
  - "configured live/test mode mismatch is refused by the production verifier adapter"
  - "altered duplicate provider event identity is rejected and does not replace the retained event or receipt"
  - "%s is still persisted as permanent revocation; restoration cannot revive the receipt", run for refund after authorization revoked, refund after job cancelled, and cancel after the session is gone.
  - "late/out-of-order: refund before the paid webhook retry, then a distinct later completion, never yields paid"
  - "per-finding, subscription, unsupported-mode and USDC paths refuse explicitly rather than becoming prepaid authority". The strict bridge throws `settled_fixed_payment_required` / `per_finding_contract_unsupported` / `usdc_release_currency_contract_unsupported`; SQL raises `canonical_quote_refused`.
- **Held costs:** "scripted target responses never settle; unverified receipts refuse; reservations stay held at the pinned job cap". The reservation stays unsettled with `job:<id>` cap 3,000,000; the operation stays `dispatched` with no receipt; a raised `jobCapMicroUsd` is refused; no naive session is created.

## Characterizations (current behavior; explicitly NOT acceptance)
These are in `payment.characterization.test.ts`, and all pass.
- **Refund during an ownership change** — "characterization: a signed refund arriving while canonical job ownership differs is refused by ingest_event (canonical_job_refused) and is not retained; restoring ownership revives the receipt". This is fail-closed while ownership differs (`001-current-payment.sql:63`). If ownership is restored after the provider stops retrying, the refund is lost. No current route changes `jobs.customer_id`, so this is Info/Low, not a finding.
- **Refunded receipts report `waiting`** — "characterization: after refund the company payment port reports waiting (not invalid); re-offering the same quote refuses". The skip is at `autonomy-release.ts:133`. Re-offering the quote fails with `binding_replay_conflict`, so the state is fail-closed, but the job never reaches a terminal `invalid`.
- **Disputes are ignored** — "characterization: charge.dispute.created (chargeback) is ignored by the bridge and the receipt remains valid". Disputes are outside the handled set (`current-payment.ts:106`). Info: disputes/chargebacks are not part of the documented revocation contract.
- **`pending_webhooks`-only change conflicts** — "characterization: a redelivered event with the same id whose only change is pending_webhooks is rejected as an identity conflict". The digest covers the entire verified event (`current-payment.ts:144`). Whether Stripe redeliveries change such fields is unverified offline.
- **Publication refused after delivery** — "characterization: a completed autonomous publication is refused (409) once the canonical job state is delivered". The terminal set is at `current-payment.ts:26,38`. Info: this is an availability concern if owner adapters move autonomous jobs to `delivered`.

## Commands and results (repo root)
- `node tests/track-b/current-company-review/run.mjs tests/track-b/current-company-review/authorization-payment`
  → Test Files 1 failed | 3 passed (4); **Tests 2 failed | 35 passed (37)**; exit 1. The 2 failures are AP-1 and AP-2 (intended repros);
  `composed.invariants` 28/28, `calendar.invariants` 2/2, `payment.characterization` 5/5. Candidate hash check passed (2,041 files).

## Not verified
- Real Stripe delivery/retry payload stability, account/mode configuration, and dispute/refund event subscriptions.
- Hosted Workflow replay and independent PostgreSQL connection races; PGlite serializes queries.
- Actual owner adapters (the shipped loader is fail-closed), so these tests inject them.
- Exclusive legacy dispatch.
- The hosted session/cookie stack.
- The private chat route's per-request reauthorization; it was read but not exercised here, and remains covered by `docs/chat-current-authority`.
- (Resolved by integrator) Strict TypeScript over all review tests: `run.mjs --typecheck` exits 0.
