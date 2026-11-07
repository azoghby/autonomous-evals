# Track B text security review

Reviewed local baseline `800a0b243fd251e1b7df62e8d5f1dfcc734ddb59` on November 7, 2026. Scope: `packages/core/src/evals/text/**`, with the existing Gateway adapter read to distinguish module behavior from adapter mitigations. Read `TRACKS.md`, `docs/TRACK_B_INTEGRATION.md`, `docs/track-b-text-eval.md`, and `docs/track-b-judges.md`; no repository AGENTS.md file was present. Applied the user-supplied instructions. ECC was not enabled. No delegation, live APIs, installations, cloud operations, spending, outreach, push, or PR.

Only this document and `tests/track-b/text-security-review/**` are owned changes. Production modules, shared contracts, manifests, eval integration/data adapters and PostgreSQL journal are unchanged.

## Proven findings

### T1 — Medium: clipped response loses legitimate investigation grounding and reproduction metadata

`investigate.ts:63–72` runs the selected reproduction, then validates the investigator's citation exclusively against the clipped `original.responseText`. The evaluator already retained verbatim check evidence from the complete response. A forbidden marker after character 20,000 produces an objective failure and a genuine evidence quote. The investigator can cite precisely that quote and the reproduction can fail the same check, yet the early `continue` leaves the finding inconclusive and `reproduction.attempted: false`. The actual reproduction is present in the returned `reproductions` array and `investigatorStatus` is `completed`.

Reproducer: response `READY ` + 20,100 `x` characters + ` FORBIDDEN_MARKER`; objective `not_contains` that marker; investigator confirms with the original check's exact evidence quote and requests S01. Both checks fail, but the finding claims no reproduction attempt. This is a conservative false negative plus incorrect attempt metadata, not a false confirmation.

Integration implication: persist the entire investigation including its `reproductions`, not only findings or `investigatorStatus`. Do not infer that an attempted-false finding means no outbound reproduction occurred. Preserve the original objective failure and evidence even if investigator confirmation is unavailable. A production fix should record attempts independently of verdict acceptance and validate clipped-response citations against trusted original check evidence or separately retained full evidence. Never accept arbitrary investigator text as a substitute for trusted evidence.

### T2 — Medium at injected judge boundary: blank factual reference can receive a pass

`schema.ts` permits `referenceText: ''` and whitespace; `execute.ts:147` only guards null. With a valid injected judge returning `passed`, a factual rubric with no substantive reference receives `pass` and an overall pass. The no-reference investigation limitation is also added only for null.

Important mitigation: the actual `createGatewayJudge` checks `reference?.trim()` and returns inconclusive before authentication, authorization or transport. The review exercises that real adapter with local injected dependencies: no dispatch occurs; Text Eval records `inconclusive/judge_inconclusive`, rather than `not_assessed/no_reference`. A live factual false pass through that adapter is **not proven**.

Integration implication: normalize empty/whitespace reference input to null before design/freeze and retain the richer not-assessed status. Preserve an already frozen suite's digest; normalization after freezing is an edit and must not silently rewrite the stored artifact. Alternative judge implementations must enforce the same absence rule; do not assume the text module does so.

### T3 — Medium boundary weakness, mitigated by Gateway: fabricated rubric pass citation survives as pass

`execute.ts:179–183` verifies concern quotations but accepts `passed` before applying the invalid-citation check. A judge returning pass with `evidenceQuotes: ['FABRICATED ANSWER']` for response `READY` produces pass with empty evidence. `executionVerdict` returns pass and `textRunForMonitoring` emits `passed`. The corresponding fabricated concern correctly stays inconclusive. This proves asymmetric validation; it does not prove the response actually violated the rubric.

Important mitigation: `createGatewayJudge` rejects invented quotations for all verdicts. An injected local transport returning the fabricated pass is rejected by that adapter and Text Eval stores `inconclusive/judge_unavailable`. No live Gateway acceptance or prompt-injection success is claimed.

Integration implication: retain this adapter validation when binding judges. A replacement judge must not treat the text module as complete citation validation. Treat rubric passes as subjective judgments even though monitoring uses the generic passed vocabulary. A module fix should reject explicitly invalid pass citations; this does not require every legitimate pass to contain a citation.

## Verified invariants and remaining trust boundaries

The original 42 text fixture tests pass unchanged, including twelve-scenario/category/identity validation, bounded design revision, original/full-response objective scoring, Unicode/CRLF grounding, two-request concurrency, unknown-state handling, three-reproduction limit, invalid identities, rerun isolation, credential refusal and monitoring identity checks. Independent review controls also reject edits to the frozen system prompt, reference, version, review and scenario order before any target call; trailing literal checks see the complete response; Unicode quote mapping remains verbatim; adversarial regex specs are rejected without evaluation.

No additional objective evaluator defect was established. Fenced JSON is deliberately accepted by the documented objective semantics; this does not prove a strict JSON consumer can parse that response. Check that suite intent matches that policy when designing a strict machine-consumption test.

SHA-256 detects changes relative to the stored digest, not authorized provenance: a caller able to replace both body and digest can construct a different valid suite. This is a parent storage/authorization requirement, not a demonstrated cross-customer vulnerability. `assertRunMatches` permits scenario subsets and validates identities rather than recomputing check results or proving complete suite coverage. Persist the intended scenario selection and bind run evidence to authorized immutable storage; a matching suite digest alone is not evidence that all twelve scenarios ran.

Reproduction limits are per invocation. Repeating investigation can resend the same selected requests; durable parent checkpoints are still required as the handoff states. This review does not duplicate or validate the concurrent durable integration work. Schema-valid investigator/engineer JSON is not proof of semantic correctness or resistance to real model prompt injection. Escaped untrusted delimiters and fake model outputs test deterministic boundaries only.

## Reproduction and results

Prerequisite: an existing offline dependency directory containing the declared Track B dependencies. The runner neither installs nor fetches. Default is `tests/track-b/node_modules`; `TEXT_REVIEW_NODE_MODULES` can select an existing cache. It copies the current checkout to temporary staging, runs strict TypeScript over review and existing text tests plus their imported source, runs only those tests, and removes staging. It does not alter any source assertions.

Executed:

```sh
TEXT_REVIEW_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules node tests/track-b/text-security-review/run.mjs
```

Result: exit 0; strict TypeScript passes; **52 passed + 3 expected failures = 55 tests across 4 files**. These comprise the original 42 tests and 13 review cases. The three `it.fails` safety invariants deliberately reproduce T1/T2/T3 and are paired with ordinary assertions of the exact observed behavior. A green command therefore does **not** mean these defects are fixed. After production fixes, convert the corresponding expected-failure case to a normal test and update its characterization; Vitest otherwise flags an unexpected pass.

Initial review-only compilation found test-helper typing errors, corrected only in the owned tests before the final successful run. No full repository/integration/live-provider checks were run. Local Gateway transport stubs establish adapter control flow, not provider availability, durable usage storage, authenticated job binding or production integration.
