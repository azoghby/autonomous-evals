# Durable judge attempts and accounting candidate

This unapplied 14-file increment requires the exact `naive-budget-envelope-integration` candidate reviewed at `0832de5`. The approved 39-file factual Workflow patch was separately adopted into actual source at `deaaff4` during this work. That approval does not adopt this newer judge candidate or the intervening budget/recovery layers. Future adoption must compare the composed result with current source instead of replaying overlapping historical patches.

## Connected behavior

The core attempt store accepts trusted same-transaction ledger and authority hooks. The host locks the canonical job before the operation, validates current execution and stage authority, and reserves through the shared ledger including parent envelopes and immutable additional scopes. Dispatch checks current authority again before committing the irreversible send fence. Local scope revocation prevents commit. No dispatched or unknown attempt can be reopened.

`NAIVE_JUDGE_ATTEMPTS=1` selects v2 only for a new logical operation. Retained legacy checkpoints/reservations remain v1; retained attempts and immutable mode choices remain v2 even if this fresh-selection flag changes. A retained v2 choice requires the sidecar and cannot fall back to v1. Mode selection itself checks current authority in its transaction. Existing `EVAL_SERVICES` and selected-profile gates remain authoritative.

Generic and expert factories perform bounded accounting before paid execution authorization or budget refusal. The server-only accounting capability contains audit reads and settlement, never provider creation or evaluation entitlement. It traverses up to forty pages of twenty-five retained intents; unresolved evidence or more work keeps paid execution held. The existing private billing endpoint now enumerates exact v1/v2 intents. Operator recovery remains a separate fresh-authenticated action with an explicit reason and immutable audit.

V2 settlement reconstructs exact immutable period, caps, additional scopes, attempt/checkpoint/reservation identity and measured provider receipt. Canceled jobs and revoked evaluation plans can settle already-incurred costs. An abandoned unused attempt is resolved separately as `unused` only when its immutable recovery audit, original reservation/scopes, terminal state and accepted-zero or denied-unreserved evidence agree and no contradictory received/billing/completed-verdict evidence exists. This does not create a zero-cost provider receipt. Invalid or unknown evidence stays pending. A recovered unused intent therefore cannot block every future factory invocation forever.

## Evidence and limits

Final candidate verification: **4,541 tests passed, zero failures, two documented skips**; web/core TypeScript and offline-font production build (63 steps/four workflows) pass. Independent patch application, two fresh assemblies and the post-build audit match all 2,398 source/SQL hashes. Actual approved39 source separately passes 4,116 tests and types/build; see its adoption receipt. The skipped tests require suite regeneration or a live Neon sandbox.

Six actual SQL/runtime composition tests cover measured replay, explicit operator abandonment and later attempt, cancellation before dispatch, revoked/canceled accounting through the real production `settleCost` sink, retained legacy identity, and abandoned intent drainage before the next prepare. The prepare/retry scenario reuses target evidence within one live stage; it does not establish cross-process recovery of mixed target/judge callbacks. Providers/audit are fixtures. Some tests use a keyed fixture sink; the revoked accounting case exercises the real SQL sink. Operator authentication is freshly rechecked but is not a transactionally locked session-revocation protocol.

The reviewed `sql/001-proxy-dispatch.sql` is an exact copy of the existing core sidecar at `packages/core/src/judges/migrations/001-proxy-dispatch.sql`. Apply it once when separately authorized; the review copy is not a second migration. No live SQL was applied here.

```sh
python3 docs/naive-judge-attempt-integration/assemble.py /tmp/new-judge-review
python3 docs/naive-judge-attempt-integration/verify.py
```

Maintainers freeze stable postimages with `freeze.py`, then use `verify.py --destination <unused-one> --destination <unused-two>`. The manifest pins all inherited source/SQL paths, incremental postimages and the original sidecar. Independent patch application, two fresh assemblies and final tests/types/build have separate receipts in `validation/`.

No keys, provider calls, live migration, rollout flags, outreach, spending or deployment occurred. Native PostgreSQL contention, real provider/hosted acceptance, automatic mixed callback recovery, remaining budget coverage, post-delivery rerun, conversation/idle and full Phase 0/roster gates remain open. This package is not a claim that the Naïve plan is complete.
