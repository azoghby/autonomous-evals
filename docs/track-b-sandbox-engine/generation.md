# Sandbox generation and admission handoff

Owned implementation: `packages/core/src/evals/sandbox/generation/{adapter,gates}.ts`. Owned checks: `tests/track-b/sandbox-generation/`. No Track A runtime/spec/platform, manifest or historical evidence changes. Shared contract is exactly `aa94505fd535f5c0f586cc6325b49b71a1683761:packages/core/src/sandbox/spec.ts`, SHA-256 `71ae878f2fd00fb71a82a1310afeee1c490c7cade6cddb903e19bb2dbb147ffe`. Tests obtain it with `git show` in temporary staging; no shadow contract. Parent's identity module and sibling execution/grading modules are intentionally not imported.

## Typed integration surface

`createSandboxGenerationAdapter(config)` returns `(SandboxGenerationRequest) => Promise<SandboxGenerationResult>`. Requests contain an operation key, exact EnvironmentSpec and bounded GenerationSlots: workflow ID, category, immutable expectRefusal intent, and explicit doc/clause references. Config requires an existing AgentTaskRunner, JobRef, session/job caps, immutable `bindOperation`, idempotent `onMeasuredCost`, and `assessCandidate` ports. Use existing `AgentSessionService` with durable store/budget ledger (or existing `createPostgresAgentRuntime`), never a direct model call. No service is instantiated or called by importing this module.

GeneratedSandboxCandidate carries the exact validated scenario plus provenance: environment/request/scenario/workflow/clause hashes, slot intent, revision, task/session/agent/version. Policy and workflow source identity are checked; semantic policy correctness still requires execution and customer review. Workflow policyRefs accept exact `doc:clause` or globally unambiguous clause IDs because v1 does not specify their syntax. Refusal slots cannot become happy paths on regeneration. Generated `oracleValidated` is reset to false and never trusted.

Connect `assessCandidate` to `runScenarioGates`, preserving its passed/rejected/unresolved status; store the complete ScenarioGateEvidence under its digest. Do not implement assessment using an LLM verdict or oracleValidated. The generation callback is an infrastructure trust boundary; a dishonest callback cannot be authenticated by a TypeScript interface. Passing generation is a proposal, never customer approval. A complete result can contain dropped slots and even zero candidates; an empty suite cannot be admitted.

`runScenarioGates(GateInput, GatePorts)` uses these ports:

| Port | Required behavior |
| --- | --- |
| replay.once | Durable atomic input-digest binding, exclusive execution, keyed effect reconciliation after crashes; no blind retry of an ambiguous effect |
| startRun | New isolated SandboxRun with validated fixture SQL, limits, frozen world; stable keyed recovery |
| execute | Trusted oracle or dump-all-state execution; actual transcript, evidence reference, settled measured cost; unknown cost is null |
| grade | Complete deterministic reward checks from actual supplied run/evidence, not a model's grades |
| mutations | Bounded targeted mutation plans covering every reward-bearing oracle check |
| mutate | Isolated fork of oracle final world/evidence and actual state, trajectory or output perturbation for named target |

Do-nothing and empty-reply controls are constructed locally on fresh runs; their measured provider cost is legitimately zero. Oracle and dump ports must execute their designated agents. A unique run ID is necessary but does not itself prove underlying DB isolation. Gate orchestration requires every oracle reward check to pass, each negative control to fail at least one reward check, and every reward-bearing target to flip under mutation. Failure of an unrelated check cannot satisfy a target mutation. Missing grades, unsupported mutations, execution errors, reused run IDs, unknown costs and failed disposal are unresolved. All acquired runs are disposed, including error paths.

Required grade IDs: `state:<id>`, `expected:<id>`, `trajectory:<id>`, `output:<id>`, always `collateral`, `refusal` for expectRefusal, `media:<attachment id>`, and `security` for injection. Diagnostic checks can be non-reward-bearing. Refusal additionally requires explicit requiredOutputs; trusted grader must implement actual refusal/escalation semantics, never treat unchanged state as refusal. The gate adapter is not a second grader or sandbox runtime.

`createSuiteGateArtifact` binds exact environment, scenarios, scope and full passing evidence; it validates evidence semantics again. `admitApprovedSandboxSuite(artifact, CustomerApprovalPort)` resolves an authorized immutable server-held decision binding suite/environment/evidence digests, job/environment scope, customer and approval IDs. Missing, pending, rejected or stale approval fails. Only trusted durable evidence may enter artifact creation: hashes establish integrity, not authenticity. Resolve must authorize the current caller/customer and reject conflicting replacement writes atomically. Scope environmentId is the deployment/customer environment scope; EnvironmentSpec content identity is separately hashed. Returned values are detached snapshots; modifying them invalidates their digest on admission.

This reuses approved-suite admission concepts and existing canonical JSON, not the text frozen12 schema. Sandbox artifacts are distinct and must not be passed to the existing text approved-suite adapter.

## Durability, costs and bounded progress

Generation binds the complete request/settings digest to job + operationKey before Engineer dispatch. Stable role/purpose/attempt identity reuses AgentSessionService's persisted intent, provider idempotency, ambiguous-create recovery, budget reservation and measured settlement. Replays redeliver cost; the sink must upsert by task/session identity and reject changed amount. Unknown runner, pending session, unresolved gate or unacknowledged cost delivery never advances to another revision. Definitive slot validation or gate rejection permits at most maxAttempts (default 2, maximum 4) and then drops that slot with reasons. Fixture SQL is carried as data only, never executed in this adapter.

Gate replay.once wraps the complete operation but does not supply durable storage. Runtime/execution/mutation side effects need recovery by supplied keys when a process dies before evidence commit; a plain memoization map is insufficient in production. Persistent unresolved evidence requires explicit reconciliation/new authorized operation, not silently treating it as rejection and regenerating. Persist evidence privately with retention controls; transcripts and policy SQL may contain untrusted customer data. Admission hashes do not redact data or authorize storage. Caller must enforce authorization, privacy, secret screening, egress, deadlines and resource budgets at these execution ports. There are no provider credentials, environment variable reads, cloud calls or default live fallbacks here.

## Contract limitations and deferred acceptance

- allowedChanges has only table/description despite its predicate comment. Neither this implementation nor tests silently add predicates. Precise within-table collateral allowance remains a contract hole for the grader/runtime owner.
- Scenario/simulator seeds, calibration labels/agreement, provenance, approval signatures and durable execution statuses are absent from v1. Sidecars retain generation/gate identity; reproducibility, judge calibration and authenticated provenance require parent/platform integration. No arbitrary rubric becomes reward-bearing automatically.
- v1 TrialResult cost is a mandatory number and cannot represent unknown settlement. Gate sidecars use number|null and unresolved states; they do not fabricate a successful TrialResult or zero cost projection.
- Grade IDs above are this port protocol and require a parent bridge to the sibling grader; shared CheckResult IDs are not assumed compatible automatically. Mutation storage/forking, media oracle/security coverage, DDL/fixture SQL validation and SELECT-only query enforcement are supplied-runtime duties. Unsupported coverage remains unresolved.
- The fixture world is deliberately small and offline, not an invented acme runtime. Live Naive, Neon, Gateway, voice/vision, production isolation, spending limits and customer approval UX have not been accepted here. No paid spend or external execution is claimed.

## Commands and validation

With existing test dependencies:

```sh
node tests/track-b/sandbox-generation/run.mjs
```

To keep dependency installation outside this checkout (the existing manifests are untouched):

```sh
CHECK_DEPS=$(mktemp -d /tmp/sandbox-generation-deps.XXXXXX)
cp tests/track-b/package.json tests/track-b/package-lock.json "$CHECK_DEPS/"
npm install --prefix "$CHECK_DEPS" --ignore-scripts --no-audit --no-fund --workspaces=false
TRACK_B_NODE_MODULES="$CHECK_DEPS/node_modules" node tests/track-b/sandbox-generation/run.mjs
```

The harness stages existing source plus unchanged pinned spec/contracts, strict-typechecks selected implementation/tests and imported dependencies, runs only owned tests, rejects skipped/empty tests, and deletes staging. It does not fetch refs or contact a provider. Fixture checks cover actual gate orchestration, oracle/null/mutation behavior, separate run identity, cleanup and unknown outcomes, refusal preservation, immutable approvals, policy/provenance validation, bounded regeneration/drop, cost blocking, and real AgentSessionService replay after a lost accounting acknowledgement with an offline Naive port. Fixture cost amounts are synthetic test telemetry, not incurred spend.

Validation on this implementation: strict TypeScript passed and 22 offline tests passed with none skipped, using the temporary-dependency command above. This includes semantic rejection of rehashed fabricated passing evidence and missing version pins. No live acceptance or incurred paid cost is represented by these results.
