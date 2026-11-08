# Current autonomy payment/startup owner artifact

Extends exact artifact **f88811c8fb7509dc5996bb8cd1d148e4c23f3de3**, integrated as **28356f2e655a2559a5e5ca144439e71fc765370c**, on **039851736eabb94e85c2c111bbccc78374716275**. No historical application overwrite. Only this new directory and `tests/track-b/current-autonomy-payment-startup/` are owned. Application, core, manifests, historical artifacts and root ledger remain untouched; this local ledger records the scoped change.

`bridge/source/` and `startup/source/` are readable applied postimages. `application.patch` is the owner differential over the exact composed current artifact, not a patch over an older app. `APPLICATION.json` pins pre/post hashes. Apply f888's reviewed prerequisites first, then `git apply --check application.patch`, then apply it. Never force conflicting hunks. Apply `sql/001-current-payment.sql` separately after reconciling the owner's complete migration registry and exact release prerequisites. No migration registry is changed, no DDL runs at startup, and no historical baseline migration should run on an existing database.

The concrete bridge reads current `jobs`, latest `quotes`, owner messages and `payments`. It builds bounded, redacted commercial input without decrypting credentials. It binds exact tenant/job/environment/request/quote digest/version/package/price/scope/deliverables, requires an existing durable job Workflow, and checks current authorization again on replay. Qualification cannot revise an already accepted commercial scope: a differing model scope explicitly refuses. Clarification changes require a separately reviewed immutable request-round transition; they never reuse previous authority silently.

A compatible fixed quote produces the **existing owner-authenticated `/api/jobs/:id/accept-quote` action**. The typed `enqueueQuote` adapter must retain that exact action in the consented outbox. It does not accept a quote or fabricate approval. The existing route creates/reuses Stripe Checkout and delivers `quote_accepted` to the current job Workflow. Existing per-finding manual authorization ($3 per confirmed finding capped at the package cap, captured at delivery) remains unchanged and explicitly unsupported by this prepaid autonomous fixed-quote protocol. Base Sepolia x402 remains usable through today's route, but USDC testnet settlement is explicitly unsupported by the release's USD-only receipt contract; no USD conversion or revenue assertion is invented.

The applied Stripe webhook retains current signature verification, canonical payment recording, monitoring and resume behavior. An additional scoped adapter consumes verified events only for prepared autonomy bindings; ordinary fixed/per-finding/subscription jobs keep their current path. The production composition installs the actual `stripe().webhooks.constructEvent(raw, signature, webhookSecret())` verifier and checks configured mode. No secrets are embedded. Positive events bind exact canonical payment/session/PaymentIntent, job, quote/version/digest, event ID/digest, environment, currency and amount. Signed refund/cancellation events permanently revoke usable receipts, including after owner authority disappears. No automatic refund or capture is added.

SQL functions retain event and outbox atomically, reject altered duplicate identities, publish idempotently into the existing release receipt table, and check live canonical owner/state/quote/acceptance/session/payment plus competing payments. Both bootstrap and bounded scheduler drain handle receipts arriving before/after registration. Uncertain/conflicting provider evidence fails; it never authorizes a redispatch. PGlite fixture transactions do not establish independent-connection contention or eliminate external-effect/revocation races.

`current-autonomy-runtime` now loads an explicit reviewed owner factory in each server and Workflow step isolate. There is no global authenticated principal, ambient install call, secret serialization, or model authority. The factory and payment adapters execute with injected reviewed owners; the shipped `current-autonomy-owner.ts` reports the genuine remaining owner adapter gates instead of inventing their policy or receipts. See [startup/HANDOFF.md](startup/HANDOFF.md) and [bridge/README.md](bridge/README.md).

## Offline reproduction

With working Git metadata:

```sh
node docs/current-autonomy-payment-startup/build-artifact.mjs
node tests/track-b/current-autonomy-payment-startup/run.mjs
```

When shared Git metadata is dataless, the user-approved local pinned-file mode verifies every retained byte in the exact-current composition and all candidate source hashes before copying only inventoried tracked files (no `.env`, dependencies or build output):

```sh
export PAYMENT_PINNED_BASE=/absolute/exact/current-autonomy-candidate
node docs/current-autonomy-payment-startup/build-artifact.mjs
# Optional: final five-patch private-review inventory, checked by hash and git apply --check.
export CHAT_REVIEW_COMPOSITION=/absolute/review/docs/chat-current-authority/COMPOSITION.json
node tests/track-b/current-autonomy-payment-startup/run.mjs
```

Uses existing offline dependency/font caches, an allowlisted environment and outbound network guard. No dependency install, provider request, real webhook, secrets, spend, cloud mutation, deployment or push. The Git-free patch builder uses `git diff --no-index`/`git apply` inside temporary non-repository directories. Base composition and final postimages are separately retained. New SQL tests execute native PostgreSQL via existing PGlite with actual baseline DDL as isolated fixtures.

## Remaining activation gates

- Exact owner source-policy, secret-scanning, authorization/revocation, policy/budgets, metered data/evaluator, consented outbox and provider-receipt adapters must satisfy the typed loader handoff; no sibling source is guessed or modified.
- Reconcile **exclusive evaluation dispatch** between today's `resumeJobForPayment`/job Workflow and the autonomous scheduler. This payment patch preserves current resume semantics. The required `exclusiveDispatch(request)` callback is checked before service construction and again before evaluation; it must read the durable dispatch owner. Do not enable autonomous evaluation on the same job while legacy evaluation can also execute. This remains a code integration gate, not provider configuration.
- Owner-controlled migration identities, server-only least-privilege grants and verified Stripe account/mode/key/webhook configuration; subscribe to completion, async success, refund and cancellation events. Lost preconfiguration events require genuine provider evidence replay, never synthesized receipts.
- Real hosted Workflow replay, provider/account attestation, independent PostgreSQL races, refund reconciliation and cross-writer cost authority remain unverified. Unsupported packages, per-finding, USDC and changed commercial scopes stay explicit refusals.

Release acceptance and live-run status remain **false**. Local fixture success is not production activation.
