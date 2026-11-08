# Independent Calendar replay and budget review

Review scope: the owner-applyable Calendar extension to current-autonomy-integration candidate `f88811c8fb7509dc5996bb8cd1d148e4c23f3de3`. This review changes no application, core, historical artifact, migration, or provider state.

## Source-derived requirements

The actual Calendar engine's scenario-only target factory cannot authorize autonomous paid dispatch: it lacks the parent run checkpoint, investigation attempt and round. The extension must expose engine-issued identity after the existing durable operation/attempt intent, with no scheduler identifier, process counter, random simulator scope or scenario-only substitution. Baseline and investigation must remain distinguishable.

The durable Calendar service owns whole-phase claims. Pending or ambiguous phases remain fenced; this extension must not release claims, expire leases or resume target calls. A completed checkpoint can be read after restart without another target send. Investigation persists pending attempt intent before executing each of at most three product-failure reproductions. Transport, simulator and SQL errors are infrastructure outcomes; invalid response and round exhaustion are inconclusive; only objective SQL mismatch or assessed false success is a product failure.

Paid sends must use the existing `runAutonomousTarget` and exact minted `AutonomousPaidContext.sql`, preserving one existing reservation across job, evaluation-engineer role period and company root. The existing SQL ledger pins scope caps; unknown cost remains a hold. No successful response proves a monetary amount. Only the existing verified receipt reconciliation path can settle costs and deliver the keyed accounting row; repeated or conflicting receipt identity must not overwrite evidence.

Canonical authorization must be rechecked before target dispatch, including immutable job, tenant, environment, quote, target revision/credentials binding, suite, branch ownership and Workflow run identity. Constructor parameters and engine identity must be snapshotted against caller mutation. Simulator cleanup owns only its opened pool; it must not delete retained checkpoints, receipts, ledger reservations, branches or another caller's resources.

## Result

Source review found and resolved these concrete seams in the owned proposed source:

- The engine now emits immutable job, parent operation/run, suite ID/hash, branch, version, baseline/investigation phase, deterministic scenario scope and actual round ordinal. The app independently validates the deterministic scope and never constructs a paid target through the legacy scenario factory.
- Calendar phase checkpoint digests additionally pin a trusted execution identity containing the current Workflow ID, full job and paid policy, actual constructed target/judge reservation scopes and caps, and scalar ServiceContext. Reconstructing services with changed authority conflicts with retained phases rather than replaying evidence under the new scope.
- The application SQL wrapper is cached and paid Calendar requires the exact wrapper; the wrapper is backed by the actual session Pool used for ownership and journal locks. The previous uninitialized `applicationPool` and fresh-wrapper identity hazards are resolved. Owner configuration must mint paid authority from this exported `workflowSql()`.
- Caller-owned context and authority are snapshotted before asynchronous authorization. Every paid send rechecks canonical target/credential revision, reviewed suite hash, current Workflow, branch association and ready ownership. Target tools pass through to the existing secure target client.
- All target sends still enter `runAutonomousTarget`; neither this extension nor its core hook settles a reservation, invents a receipt, records zero cost, releases a target intent or changes receipt/accounting writers. A transport failure remains infrastructure, retains unknown holds and is not selected for product reproduction.
- Existing whole-run and whole-investigation claims remain permanent. Investigation saves its pending attempt before target dispatch. The standalone non-durable paid rerun path lacks required hook identity and refuses; this extension does not claim an autonomous appended-case or remediation lifecycle.
- Disposal remains limited to the instance-owned simulator pool. The shared application pool, branch ownership, application journal, checkpoints, holds and accounting stay retained.

No unresolved blocking source finding remains from this review. The integrator must record actual applied-source typecheck/test/build outcomes separately; this source review is not a claim those commands passed. The tests use local PGlite PostgreSQL semantics with a scripted target and mocked Pool transport; they do not demonstrate hosted Neon concurrency/advisory locks, a process kill/restart, provider billing or receipt attestation. No hosted SQL, real provider execution, cloud recovery, migration adoption or production readiness is claimed.
