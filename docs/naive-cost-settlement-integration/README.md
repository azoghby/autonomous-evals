# Atomic cost settlement owner artifact

This artifact is pinned to `4d9842b10ae13e7bc721394687aec54b9010dc01`. It contains proposed Track A source changes, **not changes applied to the application, a migration receipt, or deployment evidence**. The current app still has the old sinks until its owner adopts and deploys these bytes.

## Proposed behavior

`packages/core/src/db/cost-settlement.ts` is the shared transactional implementation. `apps/web/src/server/cost-settlement.ts` supplies a Neon Pool transaction; both job and sandbox sinks call it. New `costs.receipt_key` and `receipt_identity` columns retain canonical accounting identity, with a global partial unique index on `(source, receipt_key)`. Naïve IDs assume this installation's single provider organization. Multiple provider organizations require a trusted account namespace before adoption.

A Naïve session requires `sessionId`, measured usage and a canonical purpose. Proxy receipts use source `naive_proxy`, `requestId`, agent `judge`, measured usage and purpose; they must not be labeled as sessions. Identity is derived from the provider ID. An optional supplied `meta.idempotencyKey` must agree. Measured zero is valid. Unknown usage, invalid IDs, nonfinite/unsafe/fractional/negative amounts and changed receipt metadata are refused. Gateway calls remain unkeyed: distinct calls are not guessed to be retries.

The transaction locks and resolves the owning job or sandbox target/environment before insert or replay. It binds canonical customer, job environment, sandbox organization and environment identity. Job service contexts also carry their original owner/environment snapshot. This is an internal settlement boundary: authenticated endpoints and Workflow must authorize dispatch separately; this helper does not grant user access or provider-call authority.

New keyed receipts insert once. Conflicts compare the complete normalized accounting identity, including amount, source, agent, purpose, provider ID and canonical owner/environment. Exact replay succeeds; conflicting replay rolls back. Sandbox insert and aggregate increment happen in the same transaction. `stepBudgetContext` counts only newly inserted receipts, and only after successful persistence. Its legacy fake-store `void` result remains compatible and is treated as a new charge. Existing unkeyed gateway behavior remains one charge per call.

The migration does **not** alter, delete, backfill or merge historical rows. A new receipt that matches an unkeyed historical Naïve provider ID/key is rejected for explicit reconciliation, rather than charged twice. This is intentionally an activation gate for existing sessions. Before rollout, inventory historical receipts and retain an owner-approved reconciliation/backfill record. Deploy both sink changes together; mixed old/new writers are not a certified rollout mode.

The runner's reservation ledger remains independent and authoritative. Receipt settlement neither reserves funds nor raises a budget. Provider-billed overages remain evidence; no dollar-cap guarantee is introduced.

## Reproduce and adopt

From the repository root:

```sh
python3 docs/naive-cost-settlement-integration/build.py
node tests/track-b/naive-cost-settlement-integration/run.mjs
```

The builder reads the pinned git blobs and local helper postimages, generates `owner.patch`, and records before/after hashes in `manifest.json`. It never edits actual application source. The test runner applies the patch in an isolated temporary candidate and tests the real resulting SQL helper/migrations. See its result for precise validation scope; this is not hosted Neon or full app acceptance.

Owner adoption must verify the base/hashes against current main, reconcile later A changes, run app types/tests/build, review historical receipt inventory, apply migration `0023_cost_receipts` to staging first, and then exercise real-provider replay/concurrency through the mounted application. The snapshot and journal are included so migration metadata stays coherent. No live database credentials or operations are needed to inspect this artifact.

Jude's rich `NaiveProxyCost` still needs an explicit owner mapping: `requestId` remains `requestId`; `operationId` supplies the canonical purpose, and `model`, `measured:true`, and the exact idempotency key belong in metadata. This artifact enables the contract/sink but does not silently install Jude or the five-method factory into application composition.
