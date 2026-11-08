# Sandbox scenario Workflow replay integration

This owner-applied patch integrates the Track B whole-scenario dispatch fence into the **existing** sandbox pipeline and Workflow. It does not enable the older jobs-based company supervisor, change payment/plan contracts, or create a second run creator.

Base: `5cf5e67501bab8d8d5bd66852acf92ca24ebb083`. Exact preimage/postimage hashes and the patch hash are in `MANIFEST.json`; postimages are under `source/` using repository-relative paths. Actual application, Workflow, script, database and deployment files were not edited by this artifact.

## Apply and activation

1. Adopt the parent's `ScenarioDispatchInput.suiteId: string | null` support. Current standalone sandbox runs have a real null suite link; no synthetic suite identity is introduced.
2. In a disposable writable candidate at the exact base, verify `MANIFEST.json` and run `git apply --check <artifact>/owner.patch`, then apply the patch. Verify all six postimage hashes.
3. Supply reviewed implementations in the new `server/sandbox/scenario-dispatch-owner.ts` factory. **The included factory returns undefined.** Applying the patch alone intentionally refuses new run-world provisioning; environment variables alone do not activate it. It never falls back to unfenced execution.
4. Register/apply the existing `text_integration.checkpoints` migration through the owner migration process, with the trusted transactional SQL adapter and appropriate server-only grants. No migration is bundled or executed again automatically.
5. Run the actual-source integration suite and owner app/core typechecks/build, preserving original test assertions or documenting intentional security expectation changes. Deploy only the reviewed composed candidate.

The owner factory must return `ScenarioDispatchOwner`, whose ports are `checkpoints`, `authorize`, `currentSecrets` and `validateResult`. Use `PostgresTextCheckpointStore` with a real durable transactional database. Never supply an always-true authorizer, request-controlled SQL/identity, an in-memory production checkpoint store, or a validator that drops evidence.

`authorize` re-reads current owner, plan/run authority, environment/suite linkage, full frozen inventory, original budget cap, versions and world identity. It must compare the supplied immutable snapshot with those trusted rows, not merely check a client owner ID. `currentSecrets` includes current and retained retired credentials. `validateResult` validates the entire `ScenarioExecutionRecord`, the complete `ScenarioResult`, every scenario/trial/version binding and aggregate fields without dropping unknown data. The full immutable record is persisted before application result publication.

## Result contract

```ts
interface ScenarioExecutionRecord {
  result: ScenarioResult | null;
  budgetExhausted: boolean;
}
type ScenarioStepResult =
  | { status: 'ok' | 'budget_exhausted'; passed: number; trials: number }
  | { status: 'unresolved'; reason: string };
```

The whole result plus its original budget-exhaustion decision is checkpointed. Mutable current spend is read **inside fresh execution**, after the checkpoint claim, so completed replay restores the original record even if later spending exhausted the budget. A first execution with no remaining budget records a null result and `budgetExhausted:true`; it does not open the target/runtime or publish a fabricated scenario result.

`runScenarioTrials` derives its scope from fresh stored run/environment rows, checks owner equality, exact stored world identity and selected scenario membership, and checks a linked suite when one exists. The full inventory, selected scenario, environment and execution versions enter the immutable digest. The callback executes from the detached/frozen bound objects. Mutable cost/progress/results are excluded from identity.

After completed dispatch, `putRunResult` restores the entire saved result. A publication failure becomes unresolved, preserving the completed checkpoint for later restoration with no target/judge calls or repeated `incrementTrials`.

## Unresolved lifecycle

Both durable Workflow and inline orchestration return `{runId,status:'unresolved'}` without finalization, failure-row writes or world teardown. They mark the scenario invocation as world-retaining **before awaiting it**, so a rejected Workflow step/transport timeout also retains the world: the original worker may still be executing. This was added after independent child review found that handling only returned unresolved objects was insufficient.

No unconditional unresolved row write races the original worker's successful finalization. The existing database run may remain running. A terminated Workflow with unresolved work needs explicit owner reconciliation; this patch does not automatically restart it or take over an existing claim. World TTL/reaping policy must likewise avoid destroying a surviving authorized worker's resources.

The two e2e scripts have only a Promise<void> queue-compatibility change: they await `runRunInline(...).then(() => undefined)`. Their authoritative outcome remains the stored run row; this does not convert an unresolved run into a complete row.

## Existing-test compatibility

Assertions around normal completion, budget exhaustion, versions, costs and cleanup should remain intact with an explicit test dispatch owner and valid stored world identities. Three baseline cases need transparent treatment:

- The old exhausted-budget test passes `world_x` while the row's `worldId` is null. Seed the actual world identity; preserve the budget/no-dispatch assertion.
- The old missing-scenario case expects a thrown fatal error. It now returns unresolved, because mismatch cannot authorize cleanup of a possibly active world.
- The old result-publication failure expects failed + teardown. The corrected behavior is unresolved + retained world + completed checkpoint, allowing no-redispatch restoration.

Keep those original cases as baseline evidence or record explicit safety expectation changes; do not silently filter or weaken them.

## Verification and limits

- `git apply --check docs/scenario-workflow-integration/owner.patch` passed against the pinned base.
- Parent's first actual-source stage reported strict transitive TypeScript and 13 tests passing (real SQL checkpoint + actual runSuite/pipeline + Workflow). The parent owns `tests/track-b/scenario-workflow-integration/**` and final consolidated verification.
- Independent read-only child review found the rejected-step cleanup gap; source now retains the world before the await and checks that flag in catch/finally.
- No real application edits, Git writes, provider/cloud calls, secret reads, migration application or deployment occurred in this artifact task.

Not solved here: durable world provisioning admission, immutable onboarding startRun admission, atomic keyed cost settlement, hosted multi-worker fencing/recovery, production owner-adapter implementation, and live billing/provider acceptance. The generic fence is not evidence of full application activation or full Track B completion.

## Parent applied-source acceptance

The pinned patch applies cleanly and matches all six postimage hashes. The actual patched pipeline and Workflow passed 52 tests with real PGlite checkpoints and scripted external transports, including every original pipeline test after explicitly recorded fixture/expectation migrations. `tests/track-b/scenario-workflow-integration/BASELINE-COMPATIBILITY.json` lists each change: injected SQL fixture ports, valid world binding, new unresolved semantics, order-independent complete version equality, and strict test type fixes. No tests were filtered or skipped.

Strict transitive test compilation, full application/core production typechecks, Next type generation, and the offline Next/Workflow production build passed. The build compiled 52 steps and three Workflows. The first build attempt exposed a missing pinned demo-data fixture in the test archive; the runner now includes `data`, and the successful stage uses the exact base blob. No actual application source or hosted environment changed. The owner factory remains unconfigured: this verifies the integration contract, not live activation.

Commands: `node tests/track-b/scenario-workflow-integration/run.mjs`, then `node tests/track-b/scenario-workflow-integration/build.mjs`. Retained dependencies are required as documented in those runners; no installation occurs. Results and logs live beside the runners. B's nullable-suite prerequisite separately passed strict compilation and 489 eval tests, including 23 dispatch tests.
