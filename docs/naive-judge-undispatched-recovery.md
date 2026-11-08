# Jude undispatched recovery: core implementation and activation gates

The shared budget ledger deliberately retains the first reservation result and first settlement. A denial is not automatically retried, and a zero settlement cannot later become a measured nonzero debit. Those semantics remain unchanged.

The optional `PostgresNaiveProxyDispatchStore` addresses the separate judge lifecycle gap with durable attempts. It requires `packages/core/src/judges/migrations/001-proxy-dispatch.sql` after the agent and text sidecars. This SQL is source only; this continuation has not applied it to any live database.

## Protocol

`prepare` locks the logical job/operation, validates immutable input and budget policy, and atomically reserves an attempt-specific ID with the same shared ledger. Job, judge-month and optional additional scopes share that one reservation. Generic composition must supply its `generic-text:<job>` allocation scope; omitting it would bypass that allocation limit.

`dispatch` changes the exact prepared attempt to dispatched under the operation lock **before** calling the provider. A lost acknowledgement remains fenced. Neither retries nor operator recovery can reopen dispatched attempts.

`recoverUndispatched` requires an explicit current authorization callback inside the locked SQL transaction. It accepts only a proven undispatched attempt, settles an unused accepted hold at zero, permanently abandons that attempt and records an immutable actor/reason audit in the same transaction. A subsequent authorized prepare uses a new attempt and reservation ID. The original denied or zero-settled reservation is never reused. Replayed recovery reauthorizes and preserves the original audit.

SQL triggers protect operation identities/policies, attempt identities, allowed transitions, terminal states and recovery audits. An advisory-lock trigger coordinates old checkpoint writers with new-mode preparation: an existing legacy operation cannot be silently converted, and a new-mode operation cannot receive a competing legacy dispatch claim. Historical completed operations retain their original reconciliation path.

Read-only lookup recovers a handle after a lost prepare acknowledgement without reserving or creating anything. Fresh SQL proof of a current or historically abandoned undispatched attempt produces typed pending. Unknown state produces a distinct reconciliation-required error. Neither error is a verdict or permission to resend.

The text integration wrapper preserves those errors before caching judge/scenario/run results. It retains target responses and investigator task identities, so a reconciled retry can reuse evidence without repeating target or agent calls. Unknown state holds for operator reconciliation. Outer memoization may resume; the provider’s independent attempt fence is never released.

## Accounting

New `naive_proxy_intent.v2` receipts bind the attempt, checkpoint and reservation identity. Independent `reconcileNaiveProxyBilling({jobId, operationId, attempt}, ...)` validates that exact binding and measured provider trace before settlement and keyed cost delivery. Legacy v1 lookup remains unchanged. Recovery never constructs a new provider request and does not restore evaluation publication authority.

## Required owner activation

The actual application currently supplies no dispatch store. Therefore this is implemented core capability, **not an activated fix for H6/H7**. Before enabling it:

1. Apply and verify the optional sidecar on isolated staging, including two-connection contention and migration replay.
2. Compose the store with the same SQL, stable period, canonical job cap, `COMPANY_ROLE_DEFINITIONS.judge.monthlyMicroUsd`, and any generic allocation scope. Preserve immutable per-operation policy.
3. Provide a trusted recovery authorization callback and a private owner surface. Customer/model flags cannot approve recovery; no actor may reopen a dispatched attempt.
4. Extend owner accounting drains to enumerate and select exact v2 attempts **before** evaluator authorization/construction. The existing v1 operator candidate does not discover v2 attempts.
5. Verify real Workflow hold/reconciliation, provider receipts and deployed rollback behavior before activation. Generic selected routing must keep reconciliation-required outcomes on hold rather than fail or silently fall back to lite.

The generic candidate’s judge-month cap is separately corrected to match the expert runtime’s shared $60/month scope; the $3/job cap and generic allocation remain separate. This correction does not activate the new attempt protocol.

## Evidence

Seventy-two focused judge/store/reconciliation tests pass, including real PGlite transactions, immutable history, lost acknowledgements, stale workers, mixed legacy/new claims, additional scopes, current authorization and exact v1/v2 settlement. Parent integration tests cover pending/unknown judge outcomes, retained target replay and investigator task reuse. These are local SQL and fake-transport tests, not live PostgreSQL concurrency, provider or hosted Workflow acceptance.
