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

## Deterministic design admission follow-up

The live literal-fact defect now has an offline code safeguard; live quality acceptance remains open pending the parent's next bounded diagnostic. See [objective design admission](track-b-text-design-admission.md) for the exact conservative grammar, provenance catalog, semantic limits and legacy compatibility contract. New designs freeze code-derived catalog entries and objective constraint IDs after deterministic admission and investigator review. Unsupported objectives use the existing single revision; nothing is silently dropped. Reference-grounded meaning belongs to rubrics.

`verifyFrozenSuite` checks content integrity only. `verifyAdmittedFrozenSuite` additionally gates all text execution, investigation, reruns and monitoring. Unsafe legacy suites (including the real live fixture) remain readable for evidence/export but throw `FrozenSuiteAdmissionError` before evaluation. Store that as a test/suite defect or operator blocker, never a customer failure. Legacy content and hashes remain unchanged. The low-level freeze function supports uncatalogued historical artifacts; a frozen digest alone does not certify admission.

Current follow-up verification: strict eval harness **241 tests / 19 files**, none skipped, including integration services and PGlite checkpoints; isolated text review **96 tests / 5 files**, including all T1–T3 regressions and 30 admission tests. Commands are the same as above with the existing offline dependency cache. The final harness run resolved locally available `origin/track-a` to `c4bd22e177a6b14ecd9b505033b3a27dbdb0b061`, contract digest unchanged (`67a98dc7ddab55f56223fe40b402edae6bd0edbab4d4d070a19706fc006ae915`). An initial run exposed the data-mapping fixture's reliance on integrity-only freezing/reading; separating content integrity from the execution admission boundary preserved that compatibility without exempting unsafe suites from execution quarantine. No tests outside text were edited, no fetch/install occurred, and the temporary dependency symlink was removed.

## Prose admission v2 follow-up (offline)

The original live Lumen paragraph now supplies both meaningful system objectives with exact source quotes and offsets: `max_words: 50` and case-sensitive `not_contains: INTERNAL_ONLY`. Neither system text nor original scenario questions are rewritten. First-draft and bounded-revision injected designs execute compliant “three projects” responses successfully, fail 51-word/banned-token responses, and keep conditional fallback meaning in a rubric. New design validation rejects omission of supported unconditional system checks; moving them all into rubrics cannot obtain acceptance. Reference facts still never justify numeric literals. The original unsound frozen digest remains quarantined before outbound work.

Admission/task identity is `explicit_output.v2`; safe v1 catalogs retain original hashes and are checked with the v1 grammar. Unknown context remains conservative and may make a source rubric-only; examples, reported/quoted/code instructions and trailing scope modifiers are not promoted to commands. See [the admission design](track-b-text-design-admission.md) for precise supported forms, context limits and compatibility.

Final validation commands:

```sh
TEXT_REVIEW_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules node tests/track-b/text-security-review/run.mjs
npm --prefix tests/track-b run check -- --components evals --track-a-ref origin/track-a
node tests/track-b/calendar-integration-review/run.mjs --track-a-ref origin/track-a
```

All strict TypeScript checks pass. Selected evals: **312 tests / 21 files**, none skipped, including 13 calendar integration service tests, 12 integration service tests, 5 PGlite checkpoints and 38 PostgreSQL data-store tests. Text security review: **116 tests / 5 files**, including 50 admission tests and unchanged execution/investigation safety regressions. Calendar integration review dependents: **20 tests / 2 files**, none skipped. The final text review also strengthens the same-input v1/v2 task-identity assertion. `git diff --check` passes.

The existing offline dependency cache was temporarily symlinked at `tests/track-b/node_modules` for the selected/calendar harnesses and removed afterward. Local `origin/track-a` resolved to `103ff42059da950780213bb8ea2832521c457eb9`; shared-contract digest remains `67a98dc7ddab55f56223fe40b402edae6bd0edbab4d4d070a19706fc006ae915`. Initial new-test typing errors and a quoted conditional sentence-boundary failure were corrected before the passing runs. A disjoint read-only Sol adversarial review supplied parser cases. No ECC, Track A edits, provider/cloud calls, install/fetch, outreach, push or PR. The parent still owns the next bounded live diagnostic and real-agent quality acceptance.

## Rubric assessment binding follow-up (offline)

The third live diagnostic's S06/S07/S11/S12 defects now fail code admission, even if an investigator accepts everything. The original proposed policy bound all new rubrics to reference-required assessment; the v2 correction below supersedes that overbroad policy. the source-bound fallback check separates judged applicability from code-enforced exact response equality. The unchanged Lumen prompt, reference, twelve questions and unconditional objectives remain intact. Integrity-only reading/hashing preserves old bytes/digests; unsafe execution is rejected separately. See [rubric admission details and limitations](track-b-text-design-admission.md#rubric-admission-follow-up-reference_assessmentv2).

Task identity now also includes `reference_assessment.v1`. The objective catalog remains `explicit_output.v2`. Optional schema fields are `requiresReference?: true` (code assigned on new designs) and `conditionalInstructionId?: string` (canonical source binding). The conservative policy can leave even behavioral rubric checks unassessed without a reference; legacy unbound generic rubrics retain prior semantics, while the recognized reference-fallback source closes the actual live fixture's flag bypass. Applicability and factual usefulness remain judge responsibilities; this is not unrestricted semantic classification or proof of real-agent quality.

Final verification for this follow-up (no provider/cloud calls, install or fetch):

```sh
TEXT_REVIEW_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules node tests/track-b/text-security-review/run.mjs
npm --prefix tests/track-b run check -- --components evals --track-a-ref origin/track-a
git diff --check
```

Strict TypeScript passes; text security review passes **131 tests / 6 files**; selected evals pass **351 tests / 23 files**, none skipped. Fifteen new regressions use a byte-identical owned copy of the third live evidence solely for isolated harness staging. They cover live quarantine before dispatch, bounded design rejection despite review acceptance, false flags, removed/foreign conditional bindings, weakened templates, missing/blank references, reused bound checks, exact response violations including refusal, unknown applicability, and invalid reference citations. Existing useful-design, objective, T1–T3 and integration/PGlite tests remain green. Local `origin/track-a` resolved to `90bb8b382878c1888d998834f5758bfd5b783f51`, contract digest unchanged. A temporary symlink to the existing offline dependency cache was removed after checks. Initial new-fixture duplicate IDs and a parameterized test typing issue were corrected before final passing runs. No unowned source or historical evidence/digest was edited; no push or PR. Parent owns live validation and integration of the optional assessment fields.


## Behavioral assessment correction (reference_assessment.v2)

Proposed `113bb80d0e5ccd04bcaefe80d69341fd32fe7634` was applied locally as `46808f5`, then corrected and squashed into a single replacement commit without modifying shared judges, contracts, manifests or application code. Its live-fixture quarantine, exact conditional wording guard, source bindings and task identity are retained. V2 adds a narrow source-bound tone assessment exception to the reference default, restoring actual no-reference subjective judging under PLAN.md §4.2. See the [supported grammar and compatibility limits](track-b-text-design-admission.md#rubric-admission-follow-up-reference_assessmentv2). The new optional `behavioralInstructionId` field must be accepted by external closed-schema consumers before integration; those files are parent-owned.

The added composition tests use the real `createGatewayJudge` with injected fetch, token, authorization and usage recording. They demonstrate supported behavioral execution without reference, blocked factual/source-absence checks, evidence-backed behavioral concerns, unknown dispatch usage without retries, conditional applicability supported by exact reference quotations, exact response equality, refusal/addition/paraphrase rejection when applicable, unknown applicability, 50-word/forbidden-token failures and the valid three-project paraphrase. Missing token counts remain null and no dollar cost is invented. The separate useful-answer rubrics in the existing repaired-fixture tests remain necessary: conditional non-applicability alone does not prove a good answer.

Historical evidence is unchanged: the live JSON and owned isolated-test copy both have file SHA-256 `1e214e2c21861b2b29bef10d2105b6b2f79325d1ebeae3f625201f1a68e7dc6b`; original suite digest remains `39648dc16b59ceb3816b8096713ef6e2bbccc81404953c3263e6ba3cfc97f9c2`. S06/S07/S11/S12 remain rejected before any target or judge dispatch. No evidence was regenerated.


Final offline verification for the v2 correction:

```sh
TEXT_REVIEW_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules node tests/track-b/text-security-review/run.mjs
node tests/track-b/run-checks.mjs --components evals,judges --track-a-ref origin/track-a
git diff --check
```

Strict TypeScript passed in both harnesses. Isolated text/security review: **148 tests / 7 files**. Selected evals/judges: **397 tests / 26 files**, none skipped. Shared contracts came from already-local `origin/track-a` at `e6a77c7ad694d7cb1f562d0eeb6ff242d105a382`, contract digest `67a98dc7ddab55f56223fe40b402edae6bd0edbab4d4d070a19706fc006ae915`. The first invocation lacked local node_modules; a temporary symlink to the existing offline cache resolved it and was removed afterward. No install, network fetch, provider/cloud call, ECC, delegate, push or PR. Real-agent quality and conditional applicability accuracy remain unverified; the parent owns the bounded live diagnostic after integration review.
