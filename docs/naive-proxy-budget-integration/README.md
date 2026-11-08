# Exact proxy receipt linkage candidate

**Unapplied, not deployed.** Four incremental source/test files over `naive-shared-budget-integration`, producing 37 unique source/test paths in the complete MCP/dispatch/shared-budget chain. Reviewed against actual `1cf90a5`; main remains `5da0635`. No new SQL is required by this increment; all prerequisite schemas and ownership/activation gates remain necessary.

The prior shared-budget candidate counted settled `naive_proxy` commitments and their public cost rows separately. This layer substitutes the public row only when the existing durable evidence proves that they represent the same measured request. It does not infer a link from an amount, role or public metadata alone.

## Required proof

`retainedProxyReservation` verifies the completed billing checkpoint and its corresponding completed intent and received-identity checkpoints. Canonical job, operation, checkpoint ID, input digest, model, request ID and idempotency identity must agree. Reservation identity is recomputed using the existing `proxyBillingDigest` protocol:

- V1: hash of job and operation, matching the actual current legacy proxy runtime.
- V2: hash additionally includes the deliberate attempt; the explicit checkpoint/reservation fields must match a retained, reserved, dispatched sidecar attempt and its operation digest.

The exact `naive_proxy` cost row must have the expected request identity, measured amount, judge attribution and immutable metadata/scope identity. Direct linkage also checks the exact cost row ID and provider source. The existing session branch now explicitly validates its provider source and complete receipt-key format as well.

The shared operation must already be admitted and bound to the same job/reservation, with an identical measured ledger settlement. Linking remains inside the actual cost sink's canonical job/ownership transaction. A rollback between cost insertion and linkage preserves the existing obligation; a successful replay substitutes once without double counting. Overage remains actual measured spend.

No billing checkpoint/schema means no inferred link: historical exposure remains conservative. A matching billing record with missing, malformed, duplicate or contradictory companion evidence fails closed. A usable judge verdict is **not** required to record incurred spend. The tests demonstrate verdict independence; they do not claim to exercise a live publication-authority revocation transition.

## What remains open

Current actual and candidate expert-text runtime use the V1 path. V2 receipt validation is implemented and tested, but the optional attempt-aware dispatcher still reserves through its own ledger. This increment does **not** mount that dispatcher or establish its shared-budget admission bridge. A V2 receipt can substitute only when a shared operation already exists through an explicit bridge; the test fixture labels that distinction.

Unknown provider responses, unmeasured usage and unmatched historical commitments stay held/additive. This increment adds no new provider call, recovery retry or budget release. It does not solve concurrent Workflow callbacks, parent-child envelopes, combined customer daily budgets, pending/history UX, session sends/streaming, native PostgreSQL contention or hosted acceptance. Factual39/sourcing26 still require rebase with this chain before joint adoption.

The next stage-ownership implementation contract is in [`../naive-workflow-stage-fencing.md`](../naive-workflow-stage-fencing.md). It distinguishes Workflow invocation identity from logical business-stage identity, preserves existing provider task keys across retries, and requires dispatch/publication fencing plus explicit recovery proofs. That document is a verified design, not implemented stage ownership.

## Verification

`validation/results.json` records final counts and hashes. The focused suite uses real PGlite checkpoint storage, the actual proxy billing reconciler, `SharedJobBudgetLedger`, and the application cost sink with fake provider usage. It covers V1 replay, V2 proof/rejection, missing/contradictory evidence, cost/source/attempt substitution, rollback/retry and verdict-independent accounting. Native PostgreSQL contention and real provider acceptance remain unverified.

```sh
python3 docs/naive-proxy-budget-integration/assemble.py /tmp/new-proxy-stage
cd /tmp/new-proxy-stage/apps/web
npx --no-install next typegen
cd ../..
npx --no-install tsc -p apps/web --noEmit
npm test
cd apps/web
NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/new-proxy-stage/font-mock.cjs NEXT_TELEMETRY_DISABLED=1 npx --no-install next build --webpack
```

Assembly verifies the dependency manifests and all incremental pre/postimages. Dependencies are retained locally, not a fresh locked-install CI receipt. No actual application/core source, credential, live database, provider configuration, outreach, spend or deployment changed.
