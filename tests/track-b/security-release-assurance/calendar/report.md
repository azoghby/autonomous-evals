# Calendar verdict and retained-baseline assurance

Base inspected: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`.
ECC disabled; no children. Owned changes are confined to this directory. Production source, contracts and migrations were read/copied into a unique temporary stage, never edited. Existing comparison-monitoring and calendar-integration review reports, their tests and the post-fix implementation were inspected first. This suite adds composed partial-evidence and custom-adapter boundaries instead of rerunning their broad fixtures.

## Finding C1: retained identity can change after the immutable binding is committed

**P2, trusted custom-adapter consistency gap.** This is a passing **defect characterization**, not an acceptance assertion or a claim of an external authorization exploit.

Location: `packages/core/src/monitoring/composition.ts`, identity construction and execution verification (approximately lines 170–196). Composition snapshots the operation binding, but checks the returned artifact against `b.adapter.retainedIdentity` again after awaiting `execute()`. The latter is a live adapter property. TypeScript's `readonly` interface does not freeze a custom implementation or its nested identity fields.

Minimal repro in `boundaries.test.ts`, final describe block:

1. Custom read-only adapter advertises retained artifact A's canonical full digest/run ID.
2. SQL identity checkpoint commits A's identity.
3. Its `execute()` replaces its identity with B's digest and returns B (same calendar run, changed investigation content).
4. Composition validates B against the newly advertised identity, completes the baseline checkpoint, dispatches current, and returns B. A SQL query proves the immutable operation checkpoint still binds A while the returned baseline identity binds B.
5. Subsequent replay rejects drift, after the first result has already escaped.

All returned workflow evidence starts with actual local calendar/SQL execution. Only detached investigation metadata and the custom adapter property are changed for the repro; no database corruption or fabricated SQL grade is needed. A trusted custom adapter could do this accidentally through concurrent baseline refresh. The built-in retained adapter snapshots artifacts and freezes its identity object; its normal behavior passes the separate acceptance test. Arbitrary malicious adapter execution is outside the resolver trust model, so do not interpret this as a sandbox escape.

**Proposed minimal fix (parent-owned production change):** capture each adapter's `readOnly` flag and validated, detached retained identity once before any awaits that can execute adapter code; use those captured values for binding construction, artifact verification and returned identity. Compare returned evidence with the same snapshot committed in the binding. Fail closed on disagreement. Do not reread adapter properties as authority after execution. Flip the characterization to require rejection before current dispatch after that fix. No production fix is included here.

## Passing acceptance and regression coverage

The other 14 tests verify:

- Actual workflow with passing SQL state plus unknown required claim is inconclusive; SQL state mismatch still takes precedence and is a product failure.
- Explicit no-success classification with failing claim-required state can pass when objective state passes; a success claim with the same failed claim state is false success.
- Target errors preserve execution but no grades. Pre-initialization failure has neither execution nor readable partial state. A one-shot snapshot failure after real state creation preserves readable SQL partial state without fabricating an execution transcript.
- Claim SQL failure after objective SQL succeeds returns `sql_grading_unavailable` without stale grades, and monitoring accepts this legitimate infrastructure result.
- Positive classification without nonblank assistant evidence becomes unknown.
- Actual mixed workflow runs compose through real checkpoint SQL: three assessed pairs, nine unresolved pairs, zero regressions, numeric zero assessed delta, unresolved alert draft, calendar differences retained. Replay makes no further baseline/current adapter execution.
- Built-in retained adapter detaches caller and returned-object mutations; canonical full digest remains stable.
- Missing, uppercase-hex and extra-field custom identities reject before checkpoint writes or dispatch.
- Correctly shaped identities with changed content or run ID fail after retained read, persist ambiguity, block current and block redispatch.
- Even a matching full retained digest cannot promote SQL-unavailable evidence or unknown claims to passes, or excuse a missing required claim grade.

## Reproduction and results

Uses pre-existing local dependencies only; the runner installs nothing and fetches nothing. Local contracts are pinned to `8634ceb30f3d98de7ec24b240a4f7549dce80033` (not part of the base checkout). Exact command:

```sh
TRACK_B_REVIEW_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules node tests/track-b/security-release-assurance/calendar/run.mjs > tests/track-b/security-release-assurance/calendar/results.txt 2>&1
```

The runner stages production source without its tests, reads local Git contract blobs, runs `typescript/bin/tsc --project <unique-stage>/tsconfig.json` with strict/noEmit, then `vitest/vitest.mjs run --root <unique-stage> --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000 --reporter=default --reporter=json --outputFile.json=<unique-stage>/results.json`. It requires exactly one test file and 15 passed assertions, rejecting missing/skipped/todo/failed tests, and removes its unique temporary directory afterward.

Final result: strict TypeScript passed; **15/15 tests in one file passed**, none skipped/todo, exit 0 (73.98 seconds). Of these, 14 are acceptance/regression tests and one explicitly asserts the observed identity-swap defect. Raw output is `results.txt`.

`git diff --check -- tests/track-b/security-release-assurance/calendar` also passed (exit 0).

Development corrections: initial strict compile rejected mutating the readonly interface in the adversarial fixture; the fixture now exposes the mutable implementation type that structurally satisfies that interface. Initial runtime run had eight passes/seven failures: one test incorrectly expected a snapshot before state creation, and six exceeded Vitest's five-second default under concurrent local workloads. Corrected the expectation, added a real post-create snapshot-outage case, and set a bounded 30-second test timeout. These are test-development issues, not additional production findings.

## Limitations and handoff

PGlite executes the real migrations, simulator, SQL graders and checkpoint implementation; it does not establish production PostgreSQL multi-session behavior, failover or process-crash durability. Tests use deterministic local targets and trusted fault injection at local database/store/adapter ports. No provider/cloud/network calls, secrets, spend, outreach, deployment, push or PR. No authentication claim beyond the documented trusted resolver model. Parent must integrate and run the combined strict scoped check; this child only runs the targeted strict suite.

Owned files: `boundaries.test.ts`, `run.mjs`, `results.txt`, `report.md`.
