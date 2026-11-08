# Adopted runtime schema composition plan

Bound to adopted source `5d600a82c9470c6dad56b51998ce1bd4864ca3c0`. The adjacent JSON is an offline dependency and SHA-256 manifest. It authorizes no migration or rollout and says nothing about installed production schema. No credentials, provider APIs or databases were accessed to prepare it.

The manifest separates 33 journaled Drizzle migrations (`0000`–`0032`), 27 unique subsystem sidecars, and identical review aliases. Use journal order for base migrations. Docs copies of `0024`/`0025`/`0026`, judge dispatch, remediation accounting and sourcing authority are aliases, never additional executions. Each alias has its own path and expected hash. Base migrations are prerequisites, not changes newly introduced by this plan.

`dependsOn` is an explicit conservative DAG: direct foreign key/ALTER/trigger dependencies plus declared subsystem and runtime composition prerequisites. It does not claim to be the smallest SQL dependency graph. Every application sidecar depends on the completed base sequence. `canonicalOrder` is a topological order across the inventory; it is **not one database execution list**, because calendar belongs in a separate database.

The three profiles give full ordered closures for isolated verification:

- `application`: 33 base migrations and 21 sidecars, covering the entire adopted application runtime including expert, remediation and disabled internal/copilot capabilities. This is a schema composition superset, not activation of those capabilities.
- `optionalApplication`: the same sequence followed by independent reconciliation, application branch ownership, workflow journals, sandbox storage and autonomy sidecars.
- `simulator`: calendar SQL alone, in a different empty database. Branch ownership and workflow investigation journals belong in the application database; calendar belongs in disposable simulator seed/job databases.

The central sequence is agent persistence/text checkpoints/conversations → shared job admission → Gateway turn admission and stage ownership → stage recovery/progress/cancellation → design recovery/checkpoint ownership and model envelopes → judge dispatch → run recovery/checkpoint ownership. Independent expert data operations precede sourcing authority; base expert migrations are already included. Internal MCP precedes copilot dispatch. Remediation accounting precedes optional independent reconciliation.

Several edges are essential beyond alphabetical order. Design recovery creates `design_plan_shape`; run recovery drops and replaces it. Design/run child triggers read cancellation state. Checkpoint ownership foreign keys require text checkpoints; run ownership also requires stages and reads cancellation. Model envelopes use the shared immutable guard and stage foreign key. Gateway steps reference Gateway turns, shared operations and application costs.

Flags off do not remove all schema dependencies: `withBudget` mounts stage authority for existing mock/lite paths, publication reads cancellation outside stages, nonmock text resolves text checkpoints before method flags, and existing Gateway chat uses shared turn admission. Internal/copilot remain separately authorized capabilities even when their schema is composed offline.

Evidence pins include actual adopted run/design recovery integration tests, stage child tests, judge attempt integration tests and expert owner tests. These were inspected for their SQL setup sequences; this document does not claim new test execution. Run/design fixtures apply all base SQL followed by their actual sidecars. The proposed complete profile also includes Gateway/progress/expert/internal sidecars omitted by those narrower fixtures, allowing the next harness to check their combined compatibility.

One semantic prerequisite deserves separate verification: remediation SQL comments refer to a global `workflow_integration.cost_keys` protocol, but no canonical application SQL creates that relation. The core accounting unit test supplies it as a fixture. Do not copy fixture DDL into the application plan. The actual application's idempotent cost/receipt adapter and same-transaction settlement contract must be checked independently; schema composition alone cannot establish accounting correctness.

Offline acceptance should reject missing/changed files, alias hash drift, duplicate paths, unknown dependencies, cycles, profile order/closure errors, omitted SQL inventory paths and cross-database composition. Then apply each profile once to a fresh isolated PGlite instance with failure-stop behavior. Never retry non-idempotent SQL blindly. Native PostgreSQL data compatibility, grants, locking/contention, transaction rollback and hosted restart behavior still require separately authorized checks.

Retained target responses establish behavioral replay only. Unknown target money keeps stage/run and target holds pending; independent judge/remediation reconciliation does not establish target settlement, report publication or delivered-job recovery. Files and passing local composition are not live migration receipts or activation acceptance.

The existing `scripts/apply-sidecar-sql.mjs` runner rejects `ALTER TABLE ... DROP` through its `DESTRUCTIVE` filter, including the constraint replacements required by design/run recovery. A separately reviewed migration executor capability is required before any authorized live rollout. This plan supplies no bypass and performs no live execution.
