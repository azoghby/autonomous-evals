# Track B Text Eval

Implemented under `packages/core/src/evals/text/` only. All calls use injected ports; no credentials, live provider calls, cloud changes, deployments or spending were used to validate this slice. Recovered the prior failed checkout's objective/schema/execution/freeze modules and corrected their unknown-state, suite-validation and regex handling.

## Parent integration

Import from `packages/core/src/evals/text/index.ts` (Node runtime). Existing shared contracts and service adapter are unchanged. Exact public signatures:

```ts
designTextSuite(
  input: TextDesignInput,
  deps: { runner: AgentTaskRunner; budgetMicroUsd?: number; now?: () => Date }
): Promise<TextDesignOutcome>
// TextDesignInput = { job: JobRef; versionLabel: string;
//   systemPrompt: string | null; referenceText: string | null; knownSecrets?: readonly string[] }
// completed => { status: 'completed', suite: FrozenTextSuite, costs: CostEntry[] }
// blocked => { status: 'blocked', reason: string, costs: CostEntry[], agentOutcome?: AgentTaskOutcome<unknown> }

executeSuite(suite: FrozenTextSuite, runId: string, deps: TextExecutionDeps,
  opts?: { scenarioIds?: string[] }): Promise<SuiteRun>
executeScenario(suite: FrozenTextSuite, scenarioId: string, runId: string,
  attempt: 'initial' | 'reproduction' | 'rerun', deps: TextExecutionDeps): Promise<ScenarioExecution>

investigateTextRun(input: { job: JobRef; suite: FrozenTextSuite; run: SuiteRun;
  knownSecrets?: readonly string[] }, deps: TextExecutionDeps & {
    runner: AgentTaskRunner; budgetMicroUsd?: number
  }): Promise<TextInvestigation>

rerunTextSuite(suite: FrozenTextSuite, baseline: SuiteRun,
  runId: string, deps: TextExecutionDeps): Promise<SuiteRun>
textRunForMonitoring(suite: FrozenTextSuite, run: SuiteRun,
  targetVersion: string): MonitoringRun // structurally compatible, no runtime dependency
```

`TextExecutionDeps` is `{ target: TextTargetPort; judge: RubricJudge | null; evaluateObjective: ObjectiveEvaluator; clock?: { now(): Date }; concurrency?: number; knownSecrets?: readonly string[] }`. Supply existing `evaluateObjectiveCheck`, `createTextTarget(endpoint, transport?)`, and `createGatewayJudge(...)` directly. Credentials stay inside the target closure; never put the endpoint configuration or decrypted key in the design input. `knownSecrets` is only a refusal safety net; it never enters agent/judge messages. Recognizable credential-bearing target responses become infrastructure errors and are not persisted or judged.

`TextInvestigation` returns `{ findings: Finding[]; testDefects: TestDefectRecord[]; reproductions: ScenarioExecution[]; costs: CostEntry[]; investigatorStatus: string; limitations: string[] }`. Findings are existing rich eval findings, accepted by reporting through its rich-findings path. Preserve check status and execution gaps alongside findings: an empty findings list does not establish a clean suite.

Recommended Workflow steps: design/review; persist the frozen JSON and canonical body digest in the authorized job branch; execute and persist the complete run/check evidence; investigate and persist findings/reproductions/defects; render using existing reporting. Record each returned session cost with the existing `naive:<externalId>` idempotency convention. The injected judge records its own usage; customer target/provider cost remains unknown. On a blocked design inspect `agentOutcome` and map pending to resumption of the same step, paused/exhausted budget to budget pause, and other failures to operator intervention. Do not start a new agent attempt automatically.

Parent owns authorization, target binding, durable storage, costs, step replay/idempotency, branch/evidence links, and exports. Persist returned artifacts before the next step. Load the stored frozen suite on resume, rather than rerunning design (freeze time is assigned on completion). Target sends and judge calls are not memoized by this module: persist scenario executions and completed investigations and skip them on Workflow replay. Repeating `investigateTextRun` can resend its selected reproductions unless the parent checkpoints it. Exactly-once target calls require a durable execution adapter/step boundary; there is no hidden persistence claim here.

## Behavior and bounds

Engineer produces exactly twelve scenarios; code validates IDs S01–S12, global check identity uniqueness, and at least three scenarios in each of ordinary use, instruction edges, and grounding/ambiguity. Investigator must explicitly review every scenario. At most one revised engineer draft and review are permitted. Invalid/rejected suites never execute; no silent scope reduction. Rejection reasons and all contributing task/session identities are frozen with the suite. Task purposes bind input content, revision and reviewed draft, so changed inputs do not reuse a stale session.

Freeze uses SHA-256 over canonical sorted-key JSON of the complete suite body, including the authoritative system prompt (even null), reference text, scenarios and review. Integrity is checked before outbound calls. Arrays preserve order. Persist/export the full suite JSON and canonical body bytes separately if the parent's monitoring store hashes raw bytes; `canonicalSuiteJson(body)` hashes to `suite.digest`.

Objective checks support literal contains/absence/alternatives, Unicode character counts, whitespace word counts, normalized line counts, JSON validity and own-key presence. Agent regex specifications are deliberately rejected; arbitrary regex cannot cause catastrophic backtracking. Invalid check execution is a test defect, never a customer failure. Literal/length checks evaluate the complete target text; only persisted response text is clipped to 20,000 characters, with an explicit flag. Quotes retain exact original Unicode/CRLF text.

Two concurrent target requests maximum. Infrastructure failures discard raw error messages and remain inconclusive. Rubric results remain labeled subjective; missing judge, failed judge, fabricated concern evidence and unknown results stay inconclusive. Factual rubrics without reference text are `not_assessed`, including when no judge is configured. A scenario with unresolved checks cannot receive an overall pass. Objective failure can coexist with unresolved rubric checks; inspect `executionGaps` for complete coverage.

Investigator citations must be verbatim response text. Unknown or duplicate candidate/reproduction identities invalidate the review. At most three distinct candidate scenarios run once for reproduction, with a deterministic distinct run ID. Original evidence remains intact. Objective confirmation requires investigator agreement plus the same objective check failing again; unreproduced/disputed candidates remain inconclusive. Objective dismissal records a test defect and preserves the original code result. Repeated rubric concerns remain subjective. Reproduction errors are unknown, never a reproduced failure. Reruns require a new run ID and the same verified frozen suite; baseline objects remain untouched.

Monitoring projection maps objective pass/fail to definitive results, rubric concerns to inconclusive, and infrastructure failures to infrastructure_error. Evidence IDs are deterministic references for parent persistence; they are not Blob URLs or authorization tokens. Use the existing monitoring comparison service for observed differences only, without statistical significance claims.

## Validation and gaps

Fixture tests cover injected engineer/investigator design and bounded revision, suite integrity/category/identity guards, objective scoring and Unicode evidence, target/judge failure isolation, concurrency, citation validation, bounded reproduction, rerun identity and baseline preservation. No live validation is claimed.

Full requested check: `npm --prefix tests/track-b run check -- --track-a-ref origin/track-a`. Shared contracts resolve locally to `e040243deec495e42e1c6f0c62e523ba356701ae`. It currently stops at pre-existing `contract-checks/schema-compat.test.ts:32` (`TS2344`, contract drift). See final handoff for component checks and any independent baseline failures. Shared contracts, adapter/types, Track A, root manifests, parent agent-review files and chat integration were not edited.

Remaining integration: Neon branch persistence/export, Workflow recovery checkpoints, authenticated parent job/run/evidence routing, report/monitoring wiring, and live customer validation. The shared boolean `RunResult.results[].passed` cannot honestly represent these statuses: persist the richer run/check objects rather than flattening unknowns. Parent must approve/implement any shared contract extension.

Validation results: 42 Text Eval fixture tests pass. The unmodified selected-component harness passes strict types and all 318 executed assertions, but exits 1 because staged Track A `contracts/conformance.test.ts` imports `@/server/services`, which the standalone harness cannot resolve. Full harness exits 2 on the schema compatibility type assertion above. A supplemental copy of the harness outside the repository excluded only that app-bound contract test, limited workers to two and allowed 30 seconds per SQL test: strict types and **475 tests across 32 files** passed for all Track B source components plus contract-targets/branches/evidence. One initial parallel full-component attempt timed out an existing PGlite branch-ledger test at its default 5-second deadline; it passes in the supplemental run. No repository harness/contract edits were made to obtain these results.
