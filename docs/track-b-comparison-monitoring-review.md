# Independent comparison/monitoring review

Disposition: **request changes at two artifact authority boundaries**. This is an offline review of original `2d7928a748d14164ba176bdd5788baf57804f404`, cherry-picked alone as `f132855239004e275217ed3bb0cf524067e71e24` on the review branch. The implementation cherry-pick is separate from the artifact-only review commit. No production files were changed by this review. ECC disabled. Independent children owned arithmetic and persistence test files; the reviewer integrated and ran all checks.

## Findings for parent fixes

### R1 — P2: contradictory calendar evidence can produce false passes and regressions

Location: `packages/core/src/monitoring/composition.ts:79–90`, `richChecks` calendar branch. Definitive outcomes require only the **presence** of `execution` and `stateGrade`. Their contents are not validated against the outcome or frozen check inventory.

Minimal repro: build a frozen twelve-scenario calendar artifact with `outcome: passed`, then set every retained `stateGrade.passed` and grade result to false. `richChecks` still emits twelve passes; comparing these checks produces zero unresolved results. Other repros replace `execution.stopped` with `target_error`, empty all grade results, or change a passing result to `product_failure` with reason `sql_checks_passed`; those too are accepted, including a false regression. See the four explicitly named **defect characterization** tests in `arithmetic.test.ts`. These synthetic boundary artifacts are not claims of real SQL execution.

Impact: a stale or incorrectly composed trusted adapter artifact can produce a clean comparison or product regression unsupported by retained evidence. This is not evidence of an unauthenticated remote exploit; the resolver and adapters are trusted ports.

Exact fix: validate calendar artifacts structurally and validate each grade's exact expected check identities and aggregate boolean against the frozen scenario. Enforce the outcome/reason rules of `executeScenario` (`simulator/workflow/index.ts:85–119`): target/SQL infrastructure stops cannot be definitive; failed expected state means product failure; required unknown claims mean inconclusive; `false_success` requires a success claim and failed claim-required-state grade. Derive the verdict from validated evidence or reject contradictions. Preserve legitimate inconclusive/infrastructure partial evidence. Flip all four characterization assertions to rejection or consistent derived outcomes after the fix.

### R2 — P2: retained monitoring baseline artifact is absent from immutable operation identity

Location: `packages/core/src/monitoring/composition.ts:134–136`, binding construction, and `adapters.ts:60–64` retained adapter.

Minimal repro with actual disk-backed SQL: complete a monitoring tick against retained baseline run `original-baseline`; close/reopen the database; resolve a different retained run `replacement-baseline` with the same suite, version, target and branch under the same operation ID. Replay silently returns the old baseline and twelve regressions. A fresh tick with the same replacement returns zero regressions. The attempted baseline change is not detected. See the explicitly named **defect characterization** case in `persistence.test.ts`.

Impact: operation replay cannot verify which retained evidence the resolver selected. Retrying after an approved baseline update can silently display stale baseline evidence and interpretation. Preserving a completed result is appropriate; accepting a changed baseline request as the same identity is the defect.

Exact fix: require trusted retained baseline run ID and canonical artifact content digest in the authorization/adapter contract, include them in the immutable operation binding before current dispatch, and verify the loaded artifact matches them. Reject changed baseline identity under the same operation ID; use a new tick ID for an intentional update. Do not overwrite baseline evidence. The run ID alone is insufficient for same-ID changed content. Flip characterization to an identity-conflict rejection after the fix.

## Verified behavior and evidence

Runner: `TRACK_B_REVIEW_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules node tests/track-b/comparison-monitoring-review/run.mjs`. Uses preinstalled local dependencies, local Track A contracts pinned by resolved SHA `f0068733ca49c37f40fd7de279325f21a4b5fbbb`, strict TypeScript, and rejects failed/skipped/todo or missing test files. No package install or network needed for the recorded run. Raw output is `tests/track-b/comparison-monitoring-review/results.txt`.

- Original 20 assertions rerun unchanged; the original handoff `docs/track-b-comparison-monitoring.md` and original results were inspected. Its limitation about factory integration was accurate for that original evidence.
- Existing text monitoring, investigation/rerun, and calendar comparison/rerun tests are included explicitly. No live test files are staged.
- Independent 49-outcome-pair oracle: all seven categories fully counted, four binary pairs, 45 unresolved, exactly one regression and one improvement. Mixed paired denominator gives +0.5; fully unassessed gives null, unchanged assessed gives numeric zero. Subjective concerns and infrastructure errors never become product regressions in arithmetic.
- Exact suite, missing/extra/duplicate check inventory, evidence presence, appended application red-team inventory, job, tenant and target conflicts fail closed. Full application scenario inventory is a **trusted resolver obligation**; this cannot detect a resolver lying about omitted appended cases. Frozen twelve-case rejection is appropriate until reviewed pack execution exists.
- Actual production text wrapper + text service + SQL checkpoints: twelve passing checks, unknown cost labels despite zero known spend, full report/investigation retention and replay without another target call or cost read. A transport timeout is durably fenced as `needs_operator`; no misleading comparison is returned, and replay does not redispatch. This service behavior is stricter than the synthetic rich infrastructure-artifact case, which is also covered.
- Actual calendar simulator/SQL engine comparison runs are in the original acceptance case. Rich wrapper factories compile. The calendar production wrapper itself is not exercised end to end by this review.
- Disk-backed PGlite through actual `PostgresTextCheckpointStore`: current ambiguity retains completed baseline across close/reopen; lost completion acknowledgement leaves committed artifact replayable without redispatch.
- Separate Node/Vitest process seed/replay uses a shared disk SQL database, a real text engine fixture and the composition. The second process forbids current adapter execution and retrieves the completed comparison. This verifies orderly process restart, not an OS kill at every commit/dispatch window or actual PostgreSQL server failover.
- Costs remain known-versus-unknown; no double `recordCost` at composition. Original measured fixture entries total 18 microUSD; fixture amounts are not provider spend. Empty cost snapshots cannot imply free usage. Trusted ledger completeness and actual billing are not established.

Final expanded strict check: **59 tests in 10 files, none skipped**: 54 acceptance/regression checks plus **five passing defect characterizations**. A green suite means the defects are reproducible, not fixed. `git diff --check` passed before the artifact commit.

## Integration gates and limitations

Alert drafts contain only generic subject/text, no stable alert/delivery identity and no delivery. The caller must derive/persist a stable tenant/job/tick/artifact identity before notification dispatch; do not deduplicate on generic subject/text or treat replayed drafts as new messages. This is an explicit application integration gate, not a claim of delivered or exactly-once alerts.

Authorization is re-resolved on every replay. Tenant/job/target/branch associations, context matching inside adapter services, correct baseline selection, billing/subscription/budget/endpoint policy and version changes when target configuration changes remain trusted application obligations. No deployed app/cron wiring, customer data, live providers, network/cloud, spend, secrets, messages, push or PR operations occurred. Local PGlite serializes transactions; production PostgreSQL concurrency, worker kill windows, operator reconciliation and notification delivery require separate verification. No claim of clean production readiness or statistical reliability follows from these fixtures.
