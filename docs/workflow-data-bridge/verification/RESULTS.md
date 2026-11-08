# Applied-source verification

Command (offline, existing dependencies only):

```sh
node docs/workflow-data-bridge/verification/validate.mjs
```

The final result is recorded in [applied-results.log](applied-results.log): **43 tests in 7 files, zero skips**, plus strict TypeScript on the actual fully applied runtime source and transitive dependencies. The checks use existing installed workspace dependencies at `/tmp/workflow-bootstrap.JpxCTM`; `BRIDGE_NODE_MODULES` can select another complete existing workspace dependency directory. No dependency installation, provider/cloud request, credentials, migration deployment or spending occurs.

The stage verifies exact Workflow patch SHA-256 values and Track A/core commit pins, overlays only current pinned parent data prerequisites, applies the exact data intake patch excluding its redundant export hunk, copies the additive approved-suite port, then checks/applies the bridge. It asserts that existing `buildAgentDeps` still requires explicit versions, verified read-only directory attestation, stable budget period and namespace. Applied bridge runtime bytes must equal the reviewed source copies. The log records exact stage, bridge and admission hashes and ordered patch paths.

The 12 Workflow data tests execute the actual applied server module and SQL migration in PGlite. They cover expected task registration before dispatch, committed actual inventory before the first task exists, every nonready acquisition/review/reconciliation/cost/mapping status retained verbatim, ready suite/provenance replay without redispatch, immutable input and ready bindings, unknown tasks, cross-tenant/stale Workflow/rotated-secret refusal, inventory refresh on failure, and returned identity/payload corruption refusal. Their production advance boundary is mocked; the tests do not claim live review or design quality.

The 8 actual rich driver tests prove that all five nonready statuses prevent suite/target/report calls, exact ready data uses supported suite lookup with no independent design, complete provenance and unassessed checks reach the private artifact, missing suite admission blocks, and an absent data plan retains the standalone path. The step's external service and report boundaries are mocks.

The additive admission port has 10 tests. One additional actual text service regression uses PGlite checkpoints and the real patched `getSuite`, `runSuite`, `investigate`, and `reportInput`, through fresh factory reconstruction. A forbidden agent runner proves no redesign dispatch, exact frozen suite/provenance is retained, target replay is deduplicated, and no private suite checkpoint is fabricated. Target output is an offline fixture.

The five unchanged authenticated intake composition tests and five unchanged HTTP review tests run against the actual applied intake and route files. Two unchanged global keyed cost SQL tests prove replay deduplication, drift/cross-job refusal and ledger-write rollback. PGlite suites run sequentially (`maxWorkers:1`), with default timeouts.

Strict TypeScript includes the additive admission module and all modified runtime application/service modules, using real SDK, Neon, Next, Workflow and workspace packages. The only ambient declaration marks `server-only`; there are no replacement SDK signatures or modified runtime sources. This is a scoped transitive source check, not a full Next production build or hosted Workflow execution.

Live PostgreSQL/Neon locking and isolation, real authenticated operator review, authorized durable plan provisioning, provider dispatch and cost completeness, migrations, restart/wakeup/reconciliation, secrets/configuration, and hosted end-to-end acceptance remain release gates in the bridge README. No browser, cloud, provider or deployment acceptance is claimed.
