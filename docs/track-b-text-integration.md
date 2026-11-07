# Track B text integration

This layer lives in `packages/core/src/evals/integration/`. It composes the existing text engine, durable agent session runner, authorized target and judge closures, and PostgreSQL checkpoints. It does not implement a second objective evaluator or change Track A contracts/application tables.

## Parent wiring

Import `createTextEvaluationServices` and `PostgresTextCheckpointStore` from `evals/integration/index.ts`. Construct the store with the existing `AgentTransactionalSql` interface. `pooledCalendarDatabase(pool)` is structurally compatible: transactions must pin a connection, roll back on failure, use READ COMMITTED, and never retry callbacks. Independent `pool.query` calls or Neon HTTP queries cannot substitute for `transaction`.

Apply the optional application migration `evals/integration/migrations/001-text-integration.sql` through the parent's migration process before constructing services. The migration creates a separate `text_integration` schema; it is not installed automatically and does not alter Track A's application schema. Use the same durable database across Workflow workers/redeploys. Target/agent calls happen outside short SQL transactions.

The parent must authorize every context before resolving its job and target dependencies. Credentials belong inside `createTextTarget(endpoint, transport?)` and `createGatewayJudge(deps)` closures; do not pass endpoint configuration or decrypted keys as suite content. The resolver must return a stable, non-secret target version that changes whenever the endpoint/model/configuration changes. Gateway judge usage authorization and accounting remain the gateway adapter's responsibility. Customer provider costs remain unknown.

## Durability and operator recovery

Checkpoints bind a job, operation kind and stable ID to a canonical SHA-256 input digest. A conflicting input cannot overwrite an existing identity. Completed values replay from PostgreSQL. Persisted suites retain the engine's full frozen body and digest, including the authoritative system prompt and review history. Reruns require a new run identity and the same verified suite; baseline evidence remains intact.

A target dispatch intent is committed before sending. An interrupted dispatch has no automatic lease expiry or redispatch. A timeout or lost response cannot establish that the customer target did not execute. These operations stay pending or require operator reconciliation. Repeating the Workflow step must not clear checkpoints or create a fresh run ID to bypass this guard. This is at-most-once dispatch protection, not an exactly-once provider execution guarantee. Availability is deliberately sacrificed when execution cannot be established.

Agent session polling uses the existing durable runner and its stable task keys. A known resumable agent outcome may release the integration claim for polling. An enclosing scenario claim can also release when its underlying target checkpoint remains durably fenced; target dispatch checkpoints are never released. A process crash before an integration result is stored can require manual intervention even if the underlying agent session completed. Operator repair must inspect provider/session evidence before changing durable state; this layer provides no blind reset/retry endpoint.

Measured agent costs use the existing `naive:<externalId>` idempotency key. The parent cost sink must enforce that key atomically; an integration checkpoint cannot atomically commit a separate `ctx.recordCost` side effect. Replay can repeat delivery so an interrupted accounting write can recover. Do not use an append-only sink without deduplication. The agent budget ledger remains authoritative for reservations/settlement, independent of report cost delivery.

## Rich outputs and shared-contract boundary

Keep the full `FrozenTextSuite`, `SuiteRun` and `TextInvestigation` JSON for evidence/export. These preserve check statuses, infrastructure errors, subjective rubric concerns, not-assessed factual checks, investigation status, test defects, reproduction evidence, limits and measured session costs. Empty findings do not mean every check passed. The engine preserves its bound of three distinct reproduction scenarios, each once, with deterministic reproduction run IDs.

Track A's `RunResult.results[].passed: boolean` cannot represent these states. The explicit legacy converter rejects unresolved/infrastructure/subjective evidence instead of inventing boolean failures. Rich services are an additive factory, not a drop-in implementation of every `EvalServices` method. Track A still owns Workflow orchestration, authenticated routes, branch/evidence/artifact storage, final report delivery and any contract extension.

## Exact factory interface

```ts
createTextEvaluationServices({
  runner: AgentTaskRunner,
  checkpoints: TextCheckpointStore,
  resolve(ctx: ServiceContext): Promise<{
    job: JobRef; target: TextTargetPort; targetVersion: string;
    judge: RubricJudge | null; knownSecrets?: readonly string[];
  }>,
  clock?: Clock,
})
```

Returned methods:

```ts
designSuite(ctx, { suiteId, versionLabel, systemPrompt, referenceText }): Promise<TextDesignOutcome>
getSuite(ctx, suiteDigest): Promise<FrozenTextSuite>
runSuite(ctx, { suiteDigest, runId, scenarioIds? }): Promise<SuiteRun>
investigate(ctx, { suiteDigest, runId }): Promise<TextInvestigation>
rerun(ctx, { suiteDigest, baselineRunId, runId }): Promise<SuiteRun>
reportInput(ctx, { suiteDigest, runId }): Promise<{
  suite: FrozenTextSuite; run: SuiteRun; richFindings: Finding[];
  limitations: string[]; investigation: TextInvestigation;
}>
toLegacyRunResult(run: SuiteRun): RunResult
```

Every method calls `resolve`, including reads and report preparation. It must authorize the current caller, return the same job/environment as the context, and bind a `text_eval` job. `suiteId` is the parent's stable design identity; reuse with changed input rejects. `scenarioIds` is an optional nonempty subset. Runs execute scenarios sequentially (within the engine's maximum concurrency of two). Failed target responses conservatively require operator reconciliation; there is no automatic error-code whitelist for safe retransmission.

`designSuite` returns the engine's blocked outcome including its agent outcome where available. A pending design/investigator result should resume the same operation; budget pauses/exhaustion and other failures require the parent's corresponding job transition. Checkpoint contention throws `TrackBPendingError`; ambiguous external work throws `TrackBBlockedError` with `needs_operator`. The rich investigation result retains `investigatorStatus`; callers must inspect it before publishing a conclusion.

`reportInput` requires a completed durable investigation. Pass its `richFindings` and `limitations` to `createTrackBServices(...).renderReport(ctx, { intake, findings: [], richFindings, limitations })`, whose existing rich-findings path preserves objective/judge labels. Export the accompanying suite, run and investigation alongside the human report: rendering alone does not preserve every check. `textRunForMonitoring(suite, run, targetVersion)` remains the existing explicit monitoring projection.

Target response checkpoints retain the complete accepted response so replay never scores a clipped prefix. Scenario evidence still uses the engine's bounded stored response. The parent must apply suitable access control and retention to this checkpoint schema. Recognizable/known credential responses are refused before storage. No Blob upload, Neon branch provisioning, app migration execution or live provider validation is included. PGlite concurrency tests use queued operations on one database connection; independent PostgreSQL verification is recorded below.

## Validation

Final unchanged nested harness command:

```sh
npm --prefix tests/track-b run check -- --track-a-ref origin/track-a
```

Strict TypeScript and **622 tests across 44 files passed**, none skipped, against Track A commit `afd473788741e480b1e1bdf7728e451b5d47aaed` (contract digest `67a98dc7ddab55f56223fe40b402edae6bd0edbab4d4d070a19706fc006ae915`). The 17 new tests comprise five checkpoint tests and twelve service tests. Service tests use real PGlite checkpoints, PostgreSQL agent task/budget adapters, `AgentSessionService`, fake Naïve sessions, fake target responses and actual report rendering. They exercise frozen design replay, pending session resume, run/investigation/rerun replay, target-version conflicts, authorization refusal, paused/invalid output costs, lost cost acknowledgement, partial execution persistence loss, lost reproduction responses, competing callers and legacy rejection of unknown/rubric/infrastructure states.

An earlier full run passed strict types and the new tests but hit existing five-second PGlite timeouts in reporting restart and simulator acceptance tests while multiple harnesses competed for machine resources. After duplicate agent harnesses stopped, the complete unmodified command above passed. No root manifests, shared contracts, application schema or harness changes were used.

### Independent PostgreSQL verification

The parent ran `node tests/track-b/postgres-live/run.mjs` against current checkpoint source on November 7, 2026. Four checkpoint checks passed on real PostgreSQL 18.6, using separate one-connection pools with distinct backend PIDs. Concurrent claims produced exactly one owner; completed evidence replayed unchanged; conflicting input, forged ownership, and completion overwrite were rejected. Safe polling release rotated the owner token, and ambiguous dispatch could not be reacquired or released. Pending, completed and ambiguous records survived a clean server restart and fresh pool.

The same run passed the existing eight branch-ledger/pool checks. [Recorded output](../tests/track-b/postgres-live/checkpoint-results.txt) includes source/migration hashes, runtime versions and successful cleanup. Only a temporary loopback database was migrated. This is not a Neon/proxy, power-loss, network-partition, or live-provider test; it does not prove atomicity between a database checkpoint and external execution. Strict typing was checked separately in the 382-test selected integration run before this verification.
