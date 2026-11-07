# Independent progress projection review

Reviewed baseline: `27a4044` (including projection introduction `8e1cfab`). No ECC, network, provider, cloud or paid operations. Production code, manifests, contracts and shared harnesses were not edited. Owned artifacts are this report and `tests/track-b/progress-projection-review/**`.

## Boundary and conclusions

The authenticated caller, authorization policy, complete operation inventory, ledger completeness and consistent database view are application-supplied trusted ports. Customer JSON reaches bounded chat inputs, not those ports. The projector correctly reauthorizes direct reads and chat authorizes replay/history/poll. No customer-reachable tenant authorization bypass was established. The evidence substitutions below model wrong persisted records or application adapter mistakes; they are missing structural validation, not claims that a customer can fabricate server ports. HMAC references do not expose raw IDs/content, nor grant access by themselves.

Known measured costs retain exact micro-USD amounts, reject foreign jobs and duplicate sessions, and preserve unknown additional costs. No cost understatement or unsafe-reference exploit was established with compliant trusted ports. Consistency guarantees cannot be proved by these deterministic fakes; application transaction/RLS wiring remains outside this change.

## Findings

### R1 — Medium: expected design suite digest is ignored

Location: `packages/core/src/reporting/chat/projection/index.ts:126-128`.

The design branch verifies the suite's self hash and job, but never compares it to `ProjectionPlan.checkpoints[].suiteDigest`. A valid same-job suite other than the expected frozen suite is accepted with a planning milestone, no blockers, and an application `delivered` status. This differs from the text-run branch's explicit suite comparison. Self integrity does not establish equality with the inventory's authorized artifact.

Repro: test `R1 accepts a valid same-job frozen suite different from the expected suite digest` supplies a real frozen suite and a different expected digest. Output still has `status: delivered` and no blockers. The digest-drift control for the checkpoint key rejects, so this is specifically the missing value-to-suite binding.

Minimal fix: when the trusted inventory provides an expected design `suiteDigest`, compare `suite.digest` with it. If completion requires this additional binding for every design, persist the resulting digest in authorized job metadata and require it when resolving completed designs. Retain job, self-hash and timestamp checks; add a mismatch rejection acceptance test.

### R2 — Medium: calendar investigation's original association is never inspected

Location: `packages/core/src/reporting/chat/projection/index.ts:111-120`.

The actual `CalendarInvestigation` returned by `investigateCalendarRun` includes `original: CalendarWorkflowRun`. The projection ignores this field entirely, including job, run, branch, suite, and scenario inventory. Even when the plan supplies the expected associations, an otherwise well-typed investigation with a foreign original and empty finding/reproduction/pending arrays becomes completed, with no blocker, and allows application `delivered` status. It would also accept an investigation missing `original` altogether.

Repro: `R2 accepts a calendar investigation whose typed original belongs to another job/run/branch/suite`. No foreign raw body is emitted; this is incorrect evidence acceptance, not demonstrated cross-tenant disclosure. An actual enclosing calendar run ID is distinct from per-scenario `scope.runId`; equality between those two is deliberately not requested.

Minimal fix: require calendar-investigation expected run/branch/suite/scenarios in the inventory; validate `original` against them using the same checks as a calendar run. Validate reproduction `originalScenarioId`, result scenario and finding associations before using their resolution to remove blockers. This is needed for completion gating even while imported findings remain omitted from chat.

### R3 — Medium: future acquisition reviews and retrievals count as current ready evidence

Location: `packages/core/src/reporting/chat/projection/index.ts:141-144` and `packages/core/src/evals/data/quality.ts` timestamp checks.

Only task update and decision times are bounded by the watermark. Quality reassessment checks that source retrieval/review and answer-review dates parse, but does not require them to precede the observation. Thus a freshly recomputed sufficient assessment can rely on reviews/retrievals in 2027 and be projected as ready/delivered as of November 2026. Recomputing the review digest does not detect this temporal contradiction. This contradicts the projection document's promise to reject future records relative to its watermark.

Repro: the two parameterized `R3` tests use a typed, sufficient source-backed nonfactual case, move either source review or retrieval into 2027, recompute the assessment, and observe ready/delivered at the old watermark. The control moving `task.updatedAt` into 2027 rejects.

Minimal fix: validate relevant acquisition evidence timestamps (source provenance retrieval/review and case verification review, plus any future attestation timestamps added to the contract) against the durable watermark before accepting ready evidence. Require them no later than the task update which saved that assessment. Preserve current assessment equality and secret screening.

### R4 — Low integration limitation: current secret policy is bypassed by stored chat replay/history

Location: `packages/core/src/reporting/chat/service.ts:70-72,81-93`.

Fresh projection calls invoke the current `knownSecrets` supplier, but replay and history return stored replies after schema validation without a policy hook. A reply admitted under an older policy remains returnable when a fresh poll is refused under the new one. Authentication is still checked on each route. This predates the projection commit but affects its documented chat wiring.

Repro: `R4 replay/history bypass newly supplied secret policy while a fresh poll refuses` first saves a normal reply, then adds synthetic marker `delivered` to the secret policy. Poll rejects; replay/history still return that marker. This intentionally artificial marker proves policy divergence; no real credential leak or likely HMAC collision is claimed. Allowlisted generated content makes practical exposure narrow.

Minimal fix: add a server-supplied current reply-screening hook at the common exchange-return boundary (including append winners, replay, history), or explicitly document that current projection screening does not cover historical replies. Preserve immutable stored replies; refusal need not rewrite history. Screening only a newly read snapshot would not screen old reply contents.

## Test semantics and verification

Run offline:

```sh
node tests/track-b/progress-projection-review/run.mjs
```

The runner stages source and owned tests in a temporary directory and uses existing local dependencies (`TRACK_B_REVIEW_NODE_MODULES` can override the default cache path). It reads contracts from local commit `be522f1e13e697017bac96728748b82cadc08ab9` without fetching, runs strict TypeScript, and executes existing reporting, acquisition/data and checkpoint tests alongside the review tests. It removes its staging directory. It performs no installation.

Tests prefixed R1–R4 under **CHARACTERIZATION** assert the currently incorrect behavior. Their passing status is evidence of the gaps, not approval or intended acceptance. After production fixes, replace their positive acceptance-of-bad-evidence assertions with refusal assertions. **ACCEPTANCE** tests separately require valid evidence acceptance, authorization before durable reads, digest conflict rejection, current secret review rejection, stale review rejection, future task rejection and foreign/duplicate cost rejection. No `any`, unsafe type assertion, skipped test or expected-failure mechanism is used in the owned TypeScript.

Verification result is recorded in `tests/track-b/progress-projection-review/results.txt`. These are local structural tests, not production route authentication, native PostgreSQL/RLS, multi-session consistency or live-provider tests.

Runner correction: the initial run passed strict types and all 274 selected test cases, but also inadvertently staged a Track A app-conformance test suite which failed import resolution (`@/server/services`). The owned runner now excludes contract test files, matching the shared harness. The final run below is the authoritative result.

Final verification: **strict TypeScript passed; 258/258 tests in 20 files passed, none skipped**, including all **13 owned review cases** and the **52 existing projection cases**. The owned cases comprise five characterization cases (R3 has two timestamp variants) and eight acceptance controls. The final result excludes Track A contract tests, which are outside this review's application-free harness.
