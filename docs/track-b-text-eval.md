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

New design inputs and newly frozen suites normalize empty or whitespace-only references to null; substantive reference text retains its original whitespace. Stored suites are verified without normalization: legacy blank references keep their original content and digest, while execution and investigation treat them as absent. Changing a stored blank to null without updating its digest fails integrity verification.

Freeze uses SHA-256 over canonical sorted-key JSON of the complete suite body, including the authoritative system prompt (even null), reference text, scenarios and review. Integrity is checked before outbound calls. Arrays preserve order. Persist/export the full suite JSON and canonical body bytes separately if the parent's monitoring store hashes raw bytes; `canonicalSuiteJson(body)` hashes to `suite.digest`.

Objective checks support literal contains/absence/alternatives, Unicode character counts, whitespace word counts, normalized line counts, JSON validity and own-key presence. Agent regex specifications are deliberately rejected; arbitrary regex cannot cause catastrophic backtracking. Invalid check execution is a test defect, never a customer failure. Literal/length checks evaluate the complete target text; only persisted response text is clipped to 20,000 characters, with an explicit flag. Quotes retain exact original Unicode/CRLF text.

Two concurrent target requests maximum. Infrastructure failures discard raw error messages and remain inconclusive. Rubric results remain labeled subjective; missing judge, failed judge, fabricated pass/concern evidence and unknown results stay inconclusive. A pass may omit citations, but every supplied citation must be valid. Factual rubrics without reference text are `not_assessed`, including when no judge is configured. A scenario with unresolved checks cannot receive an overall pass. Objective failure can coexist with unresolved rubric checks; inspect `executionGaps` for complete coverage.

Investigator citations must be verbatim stored response text or substrings of the original candidate check's trusted evidence quotes, which were verified against the complete response before clipping. An arbitrary quote outside those retained sources is rejected. Unknown or duplicate candidate/reproduction identities invalidate the review. At most three distinct candidate scenarios run once for reproduction, with a deterministic distinct run ID. Original evidence remains intact. Actual reproduction attempt, run ID, outcome and check evidence are recorded even when the investigator omits a verdict or provides an invalid citation; accepting that verdict is separate from recording the execution. Objective confirmation requires investigator agreement plus the same objective check failing again; unreproduced/disputed candidates remain inconclusive. Objective dismissal records a test defect and preserves the original code result. Repeated rubric concerns remain subjective. Reproduction errors are unknown, never a reproduced failure. Reruns require a new run ID and the same verified frozen suite; baseline objects remain untouched.

Monitoring projection maps objective pass/fail to definitive results, rubric concerns to inconclusive, and infrastructure failures to infrastructure_error. Evidence IDs are deterministic references for parent persistence; they are not Blob URLs or authorization tokens. Use the existing monitoring comparison service for observed differences only, without statistical significance claims.

## Validation and gaps

Fixture tests cover injected engineer/investigator design and bounded revision, suite integrity/category/identity guards, objective scoring and Unicode evidence, target/judge failure isolation, concurrency, citation validation, bounded reproduction, rerun identity and baseline preservation. No live validation is claimed.

Current offline verification after T1/T2/T3 fixes:

```sh
TEXT_REVIEW_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules node tests/track-b/text-security-review/run.mjs
npm --prefix tests/track-b run check -- --components evals --track-a-ref origin/track-a
```

The isolated review passes strict TypeScript and **66 tests across 4 files**, including the original 42 Text Eval fixtures and 24 review regressions. All three expected failures were converted to ordinary tests; unsafe characterization assertions now require safe behavior. Cases cover legitimate trailing evidence, fabricated/omitted citations with real reproduction metadata, blank normalization before design, legacy blank digest preservation, monitoring propagation, optional pass citations and mixed valid/fabricated quotes.

The unmodified selected harness passes strict TypeScript and **211 tests across 18 files, none skipped**, including the new `evals/integration` service (12 tests) and PostgreSQL checkpoint (5 tests) layers. Contracts were read from locally available `origin/track-a`, resolved to `0dd312d1e41647ecd69f9fcb0ab4482c04e98f39` (contract digest `67a98dc7ddab55f56223fe40b402edae6bd0edbab4d4d070a19706fc006ae915`). The harness used a temporary symlink to the existing offline dependency cache, removed after validation. No install or fetch occurred.

Initial attempts without a dependency override failed because this isolated checkout has no installed harness dependencies; the selected harness without `--track-a-ref` failed because shared contracts are absent from this checkout. Both were resolved using existing local inputs. A first review compile caught a new test parameter typing issue, corrected before successful validation. The full repository/all-component harness was not run in this fix; earlier reported broader checks are historical and are not evidence for this commit.

Remaining parent work includes authorized durable job/target/evidence routing, report/monitoring wiring, deployment and live customer validation. The selected integration fixtures exercise local injected services and PGlite SQL only; they do not prove live providers, Neon recovery or production authorization. The shared boolean `RunResult.results[].passed` cannot represent richer unknown states: persist the rich run/check objects and preserve the integration adapter's gap handling. No integration/data source, contracts, manifests or Track A app files were changed.
# Live design diagnostic: quality gate still open

On November 7, 2026, a synthetic fictional-service diagnostic exercised the real Naïve
engineer and investigator through `designTextSuite`. Both sessions completed (version 1),
and the engine produced twelve reviewed/frozen scenarios. Measured usage was 38,120 and
28,361 micro-USD, totaling **$0.066481**, within a $1 diagnostic job ceiling and $0.25
per-session caps. No customer target was called.

Manual inspection found an unsound objective constraint: S01.o1 requires the digit `3`,
although the supplied instructions do not require numeric notation. The actual objective
evaluator rejects the correct answer “The basic plan permits three projects.” Both agents
accepted that check. Similar literal factual checks exist elsewhere in this fixture.
Therefore this is **not** successful semantic suite acceptance; this frozen fixture must
not be used for customer evaluation. The code evaluator correctly executes the supplied
check, but design/review failed to distinguish an explicit literal constraint from factual
meaning. A deterministic design-admission safeguard and another bounded live validation
remain required. Preserve factual meaning in reference-grounded rubrics, not arbitrary
literal checks on paraphrasable facts.

[Full fixture evidence and reproducer result](../tests/track-b/live-evidence/text-design-2026-11-07.json)
include input, frozen suite, review session IDs, measured costs, and the rejected valid answer.
The diagnostic used the source snapshot preceding the T1–T3 fixes; those fixes concern
execution/investigation boundaries and do not address this newly observed design defect.
