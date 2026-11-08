# Bounded durable accounting reconciliation

Owned implementation: `packages/core/src/evals/remediation/accounting/reconciliation/`.
This is an internal server worker, with no route, scheduler registration, target transport,
engine resume, hold-release API, or production adapter default. No application files or
existing accounting index were changed. The explicit ownership restriction also leaves
LEDGER.md untouched; this document records the implementation and integration handoff.

The worker queries the existing pending outbox with a SQL LIMIT (1–100), authenticated
job ID, original scope membership and keyset cursor. It does not fetch unbounded
`pending()` results. `reservation` must reproduce the complete immutable original hold
and scope caps using `createAutonomousPaidReservationPolicy` and any original monitor
scope. The hold is never a price. `authority.guard(tx, null)` precedes scanning;
`guard(tx, operation)` checks current authority before lookup, receipt retention and
settlement. Guard rejection leaves operations pending. The callback is a trusted
composition capability, not authentication of arbitrary caller JSON.

Provider binding registration requires an authorized dispatched operation and an
independently retained provider request ID. Registration does not prove billing.
The explicit adapter retrieves read-only evidence and independently authenticates
provider/account/request/operation/input/usage identity and the immutable USD amount.
Receipt object shape alone, local signatures or local operation IDs are insufficient.
The adapter must retain genuine external evidence identified by `evidenceDigest`,
perform bounded authentication/retrieval, respect AbortSignal and never dispatch targets.
Unknown/no receipt or unavailable capability keeps the original hold pending. Numeric
zero requires the same authentic evidence as any other price. No token-derived prices.

Verified priced receipts commit to an append-only SQL table before settlement. The
unique `(provider, account_id, external_receipt_id)` tuple prevents reusing a charge
for another operation. Immutable evidence includes amount and token usage. After a
restart, delivery failure, or lost settlement acknowledgement, the saved exact receipt
is reused without asking the provider for an alternate price. Concurrent contradictory
receipts fail instead of overwriting saved evidence. Existing `reconcile` runs on the
pinned transaction with `deliverCost`, making reservation settlement, global keyed cost
and outbox completion atomic. The receipt key is an unambiguous JSON tuple. All global
cost writers must agree on the complete payload; the existing sink must reject conflicts.

`run({limit, afterOperationId, lookupTimeoutMs, maxDurationMs})` returns counts and the
last visited operation cursor. Failures count as failed and remain pending; absent proof
counts as pending. Advance the cursor within a sweep, then reset it for the next sweep
so unresolved earlier operations are revisited. Concurrent ticks may repeat receipt
reads; SQL identity and existing settlement fencing serialize money. The duration bound
limits admission and provider lookup, not arbitrary SQL/callback execution. The owner
must set transaction/statement/lock deadlines and bound the trusted guard/sink. Align
revocation locking with operation-then-authority lock order, or update only authority
rows; a SQL deadlock abort remains retry-safe.

## Truthful installed-provider capability

Offline inspection of installed `@usenaive-sdk/managed-agents` 0.12.3 found session
`consumed_micro_usd` / `token_usage` and `credits.ledger()` priced debit rows with session
and resource references. Those can describe session billing, but no demonstrated
mapping authenticates a remediation/judge operation's input digest, external request
and observed usage. The provided capability inventory therefore says `unavailable`;
its adapter performs no calls and returns no receipts. Gateway token counts and model
price tables likewise do not establish a request-specific authoritative charge.

The genuine remaining gate is a reviewed provider-specific billing adapter plus trusted
retained dispatch mapping that proves all those identities and immutable price using
authenticated external evidence. No type or scripted test receipt satisfies that gate.
If an actual provider has no authoritative prices, its adapter must remain unavailable
or return null. No provider/network/cloud calls, secrets, spending, deployment or push
were used here.

## Composition handoff: current app team `3f013d6d`

Apply the new optional `001-reconciliation.sql` only through the owner migration process,
after existing agent/remediation migrations. Runtime roles need schema USAGE and only
SELECT/INSERT on the new tables; never UPDATE/DELETE or schema ownership. Existing
accounting/global sink grants remain owner-managed. No runtime DDL is performed.

Minimal owner patch proposal (not applied):

1. In authenticated scheduler composition, authenticate the scheduler before any job
   enumeration. Bound job enumeration independently (for example 25 jobs), load the
   canonical current owner/company/job binding, full policy and paid caps. Require the
   current persisted `authority_digest`, enabled state and source permissions where
   applicable. Never revive a disabled or old-policy binding to reconcile.
2. Build one worker per authorized job/monitor scope with the exact SQL port and
   original reservation factory. Supply a new `guard(tx, operation)` that locks and
   rechecks current binding, canonical ownership and full policy/paid-cap digest using
   that supplied tx. The existing release `current()/paid.guard()` reads through
   `config.db` and is not by itself this atomic guard. Revocation must serialize on
   the same authority rows. Check operation policy and monitor caps on every non-null
   operation. Do not accept these callbacks, job/scope pins or adapters over HTTP.
3. Register bindings only from trusted retained provider response/checkpoint records.
   The existing Gateway `gateway_judge_usage` checkpoint has response/model references;
   authenticate their request association before using them. A caller-supplied ID is
   insufficient. Supply a genuine priced adapter or the explicit unavailable adapter.
4. Pass the existing `deliverRemediationCost` global keyed sink unchanged with the
   supplied pinned transaction. Schedule bounded receipt-only ticks with a durable
   per-job sweep cursor and fair rescheduling, independent of evaluation continuation.
   Do not run targets, reopen transport, reserve again or start new Workflow runs.

Coverage boundaries from actual source inspection: core remediation target and app
`JudgeAccounting` share `remediation_accounting.operations`; the worker supports both
(the judge has minimal dispatch evidence). Baseline autonomous targets use separate
`autonomous_paid_app.operations` and `paid.reconcile`; this worker does not scan them.
The app team must provide a separate bounded adapter preserving that ledger's policy
and evidence identity gates, or explicitly migrate its accounting under review.
`agents/runtime.ts` currently supplies `withAgentCostDelivery` with durable task outcome
replay and `naive:<externalId>` keyed delivery; no `RuntimeCostOutbox` implementation is
present in this checkout/history inspected. This worker does not claim to drain one.

Receipt approval verifies accounting evidence only. It does not verify remote
application, repair correctness, target internal behavior, engine result/checkpoint,
or remote application of this source. Current authority and source permission gates
from `docs/autonomy-paid-app-integration/source` remain in force.

## Offline verification

Run scoped PostgreSQL-semantics tests with an existing installed dependency tree:

```sh
ACCOUNTING_NODE_MODULES=/path/to/installed/node_modules node tests/track-b/accounting-reconciliation/run.mjs
```

Scripted adapters are explicitly offline fixtures. PGlite tests cover reconstructed
workers, overlapping local ticks, exact receipt retry, sink rollback, lost commit
acknowledgement, current-authority revocation during retrieval, identity/usage/money
conflicts, replayed external receipts, policy drift, scope filtering, unknown/zero
money, binding conflicts and bounded lookup/scan. PGlite is single-session and the
fixture serializes transactions; this is not independent-connection PostgreSQL race
or hosted-provider acceptance evidence.

Verification result: all 20 scoped SQL tests passed. Full `npm test -- --maxWorkers=2`
passed 2,385 tests in 179 files, with one pre-existing skip. Both commands used an
offline temporary source copy with installed dependencies; full-suite fixtures were
restored after an initial incomplete-copy failure. Required app typecheck was run
and reports unchanged missing analytics/LayoutProps and transport ipaddr typing
errors. Strict transitive worker/test compilation reports only the existing
`targets/transport.ts` ipaddr errors; no new worker/test diagnostics remain.
The full Next/Workflow build compiled workflows, then failed because Turbopack
rejects external dependency symlinks outside the temporary workspace root.
See `tests/track-b/accounting-reconciliation/verification/` for logs and results.
No broad typecheck/build pass is claimed.

All receipt reconcilers must use the new identity retention boundary to share its
external-receipt uniqueness protection. The pre-existing public core `reconcile`
method itself remains unchanged and must stay behind trusted internal composition.

Commit log: initial scoped staging attempts timed out while worktree Git metadata
reads stalled. Metadata access subsequently recovered; the scoped implementation
was staged for commit with message
`feat(accounting): add bounded durable reconciliation; genuine provider receipt gate remains`.

Parent verification (2026-11-07): copied the 13 owned files byte-for-byte into
Track B and reran the scoped suite: **20/20 passed**. Strict transitive worker/test
TypeScript also passed after selecting installed ipaddr.js 2.5 in the isolated
staging dependency directory. Shared dependency caches and production source were
not changed. The earlier dependency-version diagnostics remain recorded above;
this scoped typecheck does not claim a full application build or provider billing
acceptance. Genuine priced receipt authentication remains the production gate.
