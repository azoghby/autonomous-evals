# Workflow ↔ approved production-data bridge

Track B handoff on parent `48519bf16e04bce3397ceaeb8abea060d2636263`.
ECC disabled. Local commits only. No provider/cloud calls, installation, migration,
secrets, outreach, spend, push or PR. This directory contains an application patch;
existing app/core service sources were not edited in this checkout. The only
additional direct core files are authorized `evals/integration/approved-suite.ts`
and its samebasename test.

## Ordered application

Do not replace the original Workflow/core pins with current HEAD wholesale.
`node docs/workflow-data-bridge/stage.mjs` checks the original Workflow SHA256SUMS
and data intake bytes, then checks/applies each patch in a disposable archive:

1. Archive Track A `f0068733ca49c37f40fd7de279325f21a4b5fbbb`.
2. Check/apply `docs/progress-chat-integration/combined.patch` once.
3. Overlay the seven original core source directories from exactly
   `5906961c2a70c0d6d2999cf7086689402ff60f5b`, as recorded in the unchanged
   `docs/workflow-integration/SERIES.json`.
4. Check/apply `docs/structured-progress-integration/backend/structured-progress.patch`.
5. Check/apply `docs/workflow-integration/service-bootstrap/0001-rich-service-bindings.patch`.
6. Check/apply `docs/workflow-integration/workflow-producers/002-workflow-producers.patch`.
7. Integrate parent data prerequisites: stage overlays **only**
   `packages/core/src/evals/data` from exact `48519bf16e04bce3397ceaeb8abea060d2636263`.
   This includes data-production integration `66da7a4d408a6171994ce1af414d512733437a52`.
   Keep the Calendar operation identity and all other previously applied changes.
8. Check/apply `docs/data-production-integration/intake/track-a.patch` with
   `--exclude=packages/core/src/integration/eval-services.ts`. The excluded file
   has exactly one hunk, exporting `buildAgentDeps`. The earlier Workflow patch
   already exports and hardens it. The stager asserts the exact overlap, required
   agent versions, verified directory, dry-run verification, stable budget period
   and idempotency namespace, and verifies the file remains byte-identical.
9. Integrate additive `packages/core/src/evals/integration/approved-suite.ts`
   (and its test) from commit `a26c9cb`. It opens no database or provider.
10. Check/apply [bridge.patch](bridge.patch). It replaces the intake's independent
    cost writer with `job-store.recordCost`, which uses the already pinned global
    keyed `upsertWorkflowCost`. It adds the small public optional approved-suite
    resolver hook in the existing text service **inside the artifact**, plus the
    private durable producer bridge and actual rich Workflow calls.

For review: `python3 docs/workflow-data-bridge/build-patch.py` regenerates the last
patch from its source copies against those exact preceding stages. It does not
edit any application source in this checkout. Parent must review the artifact's
existing-service hook before integrating it; there is no private-key workaround.
The source copies are review artifacts, not modules imported by the application.

## Actual producer and service behavior

An authorized private server producer calls `registerWorkflowDataPlan(sql, scope,
input, currentKnownSecrets)`, where `input` is the exact existing
`ProductionDataInput` and scope includes tenant, job, environment and current
Workflow run. This is a concrete SQL-backed immutable capability, with no HTTP,
model or fixture authority. A conflicting plan cannot replace the first plan.
There is intentionally no invented plan inferred from candidate data.

The rich Text Workflow calls `api.advanceData()`. It publishes both existing task
IDs and the expected plan task **before** `advanceProductionData` can dispatch.
Unknown tasks without a plan or extra tasks outside the single approved suite
remain blockers and stay in inventory. Every distinct returned review, cost,
acquisition, mapping or reconciliation result is retained privately in
`data_advances`. Only a ready result with frozen evidence can bind immutable
`data_ready`. Inventory is refreshed after side effects, including thrown errors.
All nonready results stop target execution. Existing tasks/operations/reviews/costs
are never deleted, reset, completed by a clock or coerced to booleans.

The additive admission port checks current authorized scope, admitted freeze,
exact digest, approved data/reference/context and the complete provenance sidecar.
The actual rich service uses its public `resolveApprovedSuite` dependency in
`getSuite`, run, investigation, rerun and report lookup. The Workflow obtains that
exact suite via `api.text.getSuite`; it never calls `designSuite` for ready data.
The original rich design path remains for jobs with neither a data plan nor tasks.
A wrong digest, secret-bearing evidence, lost authority or conflicting frozen
result blocks. No private checkpoint ID is constructed, no suite checkpoint is
manufactured and approved evidence is never re-frozen.

The retained rich text artifact includes `dataProvenance` alongside exact suite,
run and investigation. Report construction uses those same service-bound inputs;
raw provenance/corpus/reviewer details remain private, outside chat/report prose.
SQL `data_ready` also retains the complete approved task/result/provenance for
restart. A cached ready result avoids acquisition redispatch; the underlying
orchestration already requires successful cost delivery before returning ready.

## Real unresolved gates

- **Plan admission:** the owning trusted product/Workflow planner must call the
  concrete private registration capability with an actually authorized durable
  input. Existing intake does not supply that plan. No public route is added.
  Jobs with existing tasks and no plan still stop; this is not live data readiness.
- **Migrations/private roles:** deployment owner must apply the existing agent,
  data persistence001/002, text integration and Workflow001/002 migrations, then
  artifact `apps/web/migrations/003-workflow-data.sql`. Runtime performs no DDL.
  Review old costs before keyed migration; incompatible historic identities block.
- **Scope:** one Text frozen12 suite per job only. Multiple tasks/suites, Calendar
  data admission and appended packs need separately authorized semantics. The
  original appended-pack refusal remains. No scope silently disappears.
- **Recovery:** every pending state is retained. Authenticated review submission
  does not itself resume Workflow or reconcile ambiguous operations. Authorized
  wakeup and evidence-based reconciliation remain owner work.
- **Unchanged release work:** full Next/Workflow bundling, hosted PostgreSQL role
  isolation, actual authenticated review, provider design quality, current-secret
  rotation/revocation races, final invoice completeness, remediation and live
  end-to-end acceptance remain gates. Offline fixture evidence grants no consent,
  factual approval, provider authority or claim of verified remediation.

Run `node docs/workflow-data-bridge/verification/validate.mjs` with existing offline
workspace dependencies (`BRIDGE_NODE_MODULES` override). See
[validation results](verification/RESULTS.md) for measured checks and limits.
