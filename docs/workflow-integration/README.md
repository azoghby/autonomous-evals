# Workflow integration patch series

This artifact adds a concrete single-version Text/Calendar Workflow path. It is
**not a complete integration of every requested feature**: verified remediation,
evaluation-data acquisition/review orchestration, comparison and monitoring remain
implementation work described below. No simulated port is offered as production
configuration.

Only `docs/workflow-integration/**` changes in this checkout. Patch contents target
the application owner's files; they have not been applied to the actual app,
platform, contracts, manifests or core here. ECC was not enabled. The requested
children independently owned service/bootstrap, Workflow producers, and verification.
No live provider/cloud calls, secrets, spend, outreach, push, PR or deployment.

## Exact bases and application order

Local Track A pin: `f0068733ca49c37f40fd7de279325f21a4b5fbbb`.
Core pin: `5906961c2a70c0d6d2999cf7086689402ff60f5b`, including the parent's
review-authority, finding-projection, remediation-target and provisioning fixes.
No fetch was performed. [SERIES.json](SERIES.json) records the ordered inputs.

1. Archive the exact Track A commit and check/apply the existing
   `docs/progress-chat-integration/combined.patch` once.
2. Integrate the compatible core at the exact pin. The offline harness overlays
   its seven Track B source directories onto that archive, retaining Track A
   contracts, DB and integration code. This is a test prerequisite, not a merge.
3. Check/apply `docs/structured-progress-integration/backend/structured-progress.patch`.
4. Check/apply [0001-rich-service-bindings.patch](service-bootstrap/0001-rich-service-bindings.patch).
5. Check/apply [002-workflow-producers.patch](workflow-producers/002-workflow-producers.patch).

`node docs/workflow-integration/stage.mjs` performs those exact offline archive and
apply checks and prints the disposable stage path as JSON. It never creates a
shell worktree or installs dependencies. The application owner must review/apply
separate migrations through the normal migration process; runtime does no DDL.
The service patch includes `apps/web/migrations/001-workflow-integration.sql`;
the producer migration is [002-rich-artifacts.sql](workflow-producers/migrations/002-rich-artifacts.sql).
Existing core and chat/inventory migrations remain prerequisites.

## Implemented behavior

The service layer binds the actual rich Text/Calendar factories to a canonical job,
the current stored Workflow run, environment, decrypted endpoint, current known
credentials, stable target revision and owned simulator branch. Operator admission
is authenticated using the app's existing operator API. Agent sessions reuse the
durable PostgreSQL task/budget runtime. Measured session delivery is atomically
deduplicated with the same `naive:<sessionId>` identity used by core adapters;
conflicting replay refuses to overwrite the ledger. Real mode no longer falls
back to the lite implementation for unavailable methods.

The Workflow layer dispatches the rich single-version path, retains full suite,
run and investigation JSON privately, and keeps unresolved checks and remediation
limitations visible. Missing judge configuration leaves rubric checks unassessed;
there is no unreserved Gateway call. Exact factory-produced checkpoint identities
are published as durable expected inventory before claims, and observed again
after mutations. Missing and ambiguous claims block progress. Calendar aggregate
run IDs are explicitly bound to the stable operation identity by a small core
patch **inside the artifact**; physical scenario scopes remain isolated. Branch
step replay retains the existing branch instead of deleting it.

Rich artifact reads use the existing authenticated job-viewer authorization and a
tenant/environment-bound private SQL record. Raw evidence never becomes chat prose.
The default appended red-team pack is explicitly refused; an operator must choose
`REDTEAM_PACK=off` to accept frozen12. The engine does not execute an omitted pack
and claim full coverage.

## Remaining implementation, distinct from configuration

- **Remediation:** the rich path records “Remediation not run; no fix verified.”
  Integrate `createRemediationServices` and `createRemediationTarget` with the saved
  canonical baseline suite/run/finding/checks. Implement atomic target/judge
  operation reservations, immutable dispatch receipts, priced usage/late-usage
  settlement and a durable reconciliation outbox. Call detailed verification and
  retain its complete evidence. The old shared-contract remediation closure has
  not been replaced by this series; no verified repair is claimed.
  Trace Audit's existing optional remediation attempt consequently fails closed
  in real mode and returns no verified fix; removing lite fallback must not be
  interpreted as completing that legacy method.
- **Evaluation data:** later parent `66da7a4` supplies the shared PostgreSQL
  operation ledger and authenticated review/production intake, including
  `advanceProductionData`. Reuse those implementations; they are outside this
  series' pin. Register expected task IDs and bind the authorized durable plan to
  that seam, retaining its exact approved suite/provenance through run,
  investigation and report. Unify its cost sink with this series' global keyed
  sink before concurrent use. The current driver still blocks existing data tasks
  rather than claiming completion. See [parent compatibility](PARENT-COMPATIBILITY.md).
- **Comparison/monitoring/reruns/rich pack:** establish canonical version/run
  identities and preserve separate rich evidence and report projections. The
  single-version path is not evidence these features work. Appended32 requires
  agreed execution/investigation/remediation/inventory semantics.
  The parent's forthcoming comparison/monitoring review requires retained baseline
  identity `{runId,digest}`, where digest is canonical SHA-256 of the complete
  retained artifact and is part of immutable tick binding. Use
  `createRetainedComparisonAdapter` to compute it; custom adapters must supply it.
  A changed baseline requires a new tick ID. The parent's Calendar validation of
  grades/outcome/reason against frozen checks must also be retained. Those later
  changes are not claimed as part of the recorded `5906961` pin or duplicated here.
  Parent `5ad4b41` also supplies additive reviewed packs. The driver still rejects
  appended scope until authoritative manifest/review/grader configuration, complete
  pack inventory and private evidence/report propagation are integrated. Accepted
  cases and quarantined cases must all remain visible; base12 repair proves no
  full-pack success. No parallel implementation is introduced here.
- **Recovery:** a pending/operator-required rich result stops delivery and retains
  durable claims. An owner must integrate authorized wakeup/reconciliation with
  those same identities; there is no whole-phase automatic recovery guarantee.
- **Report cost completeness:** connect an authorized full `listJobCosts` inventory
  to report construction and preserve the distinct non-session usage ledger. The
  durable measured-session sink is implemented; a complete final invoice and
  unknown provider/Gateway charges are not. Reports retain unknown cost semantics.
- **Full app acceptance:** run the owner's full Next/Workflow SDK build, actual
  runtime bundling, hosted SQL isolation, provider and authenticated end-to-end
  acceptance. Targeted offline source checks do not replace these.

Irreducible external configuration includes the real authentication/operator
session, encrypted endpoint credentials and declared stateless target semantics,
reviewed calendar input, private storage and Neon branch provisioning, verified
agent IDs/versions and stable budget period, and priced/reserved Gateway usage.
These must be configured by their authorized owner; they are not success stubs.
See [deployment acceptance](DEPLOYMENT-ACCEPTANCE.md) for release obligations.

## Offline validation

Run `node docs/workflow-integration/verification/validate.mjs` with
`WORKFLOW_NODE_MODULES` pointing to an already installed complete offline dependency
directory. No install, fetch or provider call is made. The pinned baseline passed
strict TypeScript and **1,050 tests in 60 files**, none skipped, across all seven
core directories. That baseline predates this artifact's small Calendar core
patch and is not claimed as testing the app edits. Final applied-source checks
passed **45 tests in 8 files**, none skipped, including the unchanged Calendar
service/Workflow regressions, actual SQL inventory/cost/artifact code, canonical
resolver, rich step and authorized download route. The service layer separately
passed **17 tests**. Actual Next tooling compiled **47 steps and one Workflow**;
complete app/core strict TypeScript passed with the pinned A lockfile dependencies.
Commands and boundaries are recorded under [verification](verification/RESULTS.md)
and [service validation](service-bootstrap/NOTES.md).
