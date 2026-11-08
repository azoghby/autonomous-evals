# Durable whole-scenario dispatch

`createScenarioDispatch<R>` is exported from `@ae/core/evals/sandbox/scenario-dispatch/index`. It uses the existing `PostgresTextCheckpointStore` and its optional `text_integration.checkpoints` migration; no migration was applied by this change.

## Contract

Pass immutable owner/run/environment/suite/scenario/world identity, k, the original budget cap, the complete environment and frozen scenario inventory, the selected scenario, model/runtime versions and a version for the execution/validation contract. The adapter detaches and deep-freezes these inputs before its first await. Mutable spend, progress counters, result arrays and remaining budget do not belong in this identity.

The checkpoint namespace uses the globally unique application run ID and scenario ID. Owner is included in the immutable digest, not a separate namespace: changing a run's owner conflicts with its existing fence rather than permitting another dispatch. Separate tenants must not reuse application run IDs in the same checkpoint store. All identity changes require explicit reconciliation or a genuinely new authorized run, never a caller-generated retry key.

`authorize(input)` must re-read trusted current owner, plan/run authority, environment/suite linkage, frozen inventory and world ownership. It must not compare a supplied owner ID only to another caller-supplied value. `execute(input)` receives the frozen snapshot and must use it rather than close over mutable request fields. The adapter does not provide per-call budgets, target isolation, payment authority, or source admission.

`validateResult(value,input)` must validate the complete scenario result and its scenario, trial and version binding. It may not silently remove evidence or fields: canonical input/output JSON must agree. Strict JSON excludes lossy values, invalid PostgreSQL text, custom prototypes and accessor properties. Input/result size is bounded to 8 MB; execution time limits remain the underlying engine's responsibility.

`currentSecrets()` must include current and retained retired credentials. Input and result strings are screened after decoding, including short explicit secrets. Publication reauthorizes and then screens current secrets, covering rotation during authorization. These are separate asynchronous ports; this is not a claim of atomic hosted revocation fencing. Application adapters should read coherent authority/policy snapshots and reauthorize HTTP publication as usual.

## Durable outcomes

- `completed`: full validated evidence has been committed before return. `replayed` distinguishes restoration from fresh execution. The application can restore its result row idempotently after a prior `putRunResult` failure without calling target/judge or incrementing trials again.
- `unresolved`: no success claim, new dispatch, finalization, or world teardown is authorized. Includes pending original workers, ambiguous effects, storage failures, changed identity, revoked authority and unsafe evidence. Reasons contain no raw provider/SQL errors.

The adapter never releases a claim. Lost completion and even failed ambiguity persistence leave the pending claim blocking redispatch. Completed evidence can be retained after authorization is revoked without being returned to that caller. Unresolved work needs explicit reconciliation; no lease timeout or automatic takeover is implemented.

## Track A owner integration still required

Review base: `e8e33c4e3a539ebc90ff36dcffee0bfaefc6ecad`. Actual application files are untouched. This component is not yet called by the deployed sandbox Workflow.

1. In `server/sandbox/pipeline.ts`, wrap `runSuite` inside the adapter and persist the complete `ScenarioResult` in the checkpoint before `putRunResult`. Derive the scope from fresh run/environment/suite records and the full frozen inventory. Replay must bypass budget-exhaustion early returns based on mutable spent amounts; it restores prior evidence without further spending. Wire trusted SQL/auth/secret/result-validation ports before enabling the path.
2. Extend `runSandboxScenarioStep`'s return union with `unresolved`. Do not throw an ordinary retryable exception or coerce it to `budget_exhausted`.
3. In both `sandboxRunWorkflow` and `runRunInline`, branch on `unresolved` before finalization. Retain the world, skip fail/finalize/teardown, and return an explicit non-success result. The existing unconditional `finally` cleanup must change. Do not overwrite an original worker's concurrently completed row with an unconditional unresolved-state update.
4. Preserve the original Workflow identity. Since the current application writes workflowRunId after starting the executor, a required Workflow binding must come from trusted runtime metadata or a safe pre-claim retry, not an invented value.

The existing application still needs independent keyed atomic cost settlement and immutable onboarding startRun admission. This fence does not repair those separate windows. Expiring/reaping worlds while an original worker survives also requires owner lifecycle coordination.

## Validation

The tests use real PGlite SQL and fresh adapter instances with fake external execution. They cover concurrent claims, completion replay, caller mutation, immutable identity conflicts, authorization changes, malformed/lossy evidence, ambiguous persistence failure and current-secret rotation. Independent review found a publication-order rotation gap; two regressions cover the correction. Native multi-session PostgreSQL, full application patch/build, hosted Workflow recovery and live provider execution are not established by this suite.

Final validation: strict TypeScript and all 488 eval tests across 32 files passed, none skipped, including 22 scenario-dispatch tests. Command:

```sh
node tests/track-b/run-checks.mjs --components evals \
  --track-a-ref e8e33c4e3a539ebc90ff36dcffee0bfaefc6ecad \
  --dependency-dir /tmp/sandbox-generation-deps.cBCEai/node_modules \
  --dependency-fallback-dir /tmp/workflow-bootstrap.JpxCTM/node_modules
```

Required root typecheck/test commands were attempted offline; checkout TypeScript/Vitest executables remain unavailable. No full-root pass is claimed.
