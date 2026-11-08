## Current pricing pin

Track A `ab30446` reprices Quick evals to $49/$99/$199/$299. The explicit price compatibility assertion now pins those values; aggregate provider/job spending-cap assertions are unchanged. The older quote parsing fixture remains intentionally valid for historical stored quotes. This changes a known price expectation, not payment authority or a contract schema.

# Track A / Track B contract compatibility checks

This document describes the repeatable compatibility check in `tests/track-b/` and the contract gaps it pins. It does not change any Track A contract and does not assert that Track A has integrated Track B services. Latest parent full check used exact merged revision `57db3f8a6dc1e919c6fa26217f434e10e375fa95` (contract digest `sha256:dc7936cf343e023a9f0b3b2c0ee02b3886a1f230397f282ee4aaec84a9b27101`): strict TypeScript and 1,138 tests across 68 files passed, including 25 known-gap characterizations. Historical initial validation used `673873d`; it is not the current deployment baseline.

## Running

```
git fetch origin track-a            # the check never fetches
npm ci --prefix tests/track-b --workspaces=false
npm --prefix tests/track-b run check -- --track-a-ref origin/track-a
```

- `--track-a-ref <git-ref>` (or `=<ref>`) reads `packages/core/src/contracts/**/*.ts` from that locally available revision. The ref is resolved with `git rev-parse --verify --end-of-options <ref>^{commit}` using a spawn argument vector, with no shell. Refs beginning with `-` or containing newlines are refused. Only regular non-test `.ts` blobs under the contracts path are staged, and `index.ts` and `services.ts` must exist. Files go only into the temporary staging directory; the working tree is never modified. The run prints the resolved SHA and a content digest. The SHA is also exported to tests as `TRACK_A_CONTRACT_SHA`.
- Without the flag, contracts come from `packages/core/src/contracts` if that directory exists. Merged main now contains it; prefer an explicit immutable ref for reproducible contract/support-module checks. Missing contracts still fail explicitly.
- `--components a,b` selects a partial check. Track B directories: `agents, evals, reporting, targets, simulator, monitoring, judges`. Compatibility components: `contract-schemas`, `contract-targets`, `contract-branches`, `contract-evidence`, or `contract-checks` for all four. With no `--components`, all seven directories and all compatibility components run. All are now implemented on main.
- Contract components stage the Track B code they import (`targets`, `simulator`, `judges`, `monitoring`) even when not selected, but without that code's own tests. Selecting a directory runs its tests.

Failure rules: a missing selected source directory, a directory without test files, a missing compatibility test file, an unresolvable or unsafe ref, missing contracts, a type error, a failing test, or any selected test file that did not execute, contained no tests, or has skipped/todo tests all exit non-zero with no success message.

No credentials, network, Neon, Vercel, or provider resources are used. The real HTTPS transport is exercised only with inputs it rejects before DNS or sockets (a resolver that throws proves no lookup occurs); everything else uses injected transports and fakes.

## Compile-time checks

Method-style interface signatures are bivariant in TypeScript, so a plain assignment would miss some drift. The checks therefore combine assignment with explicit variance pins:

- `createTargetServices()` is assigned to `Pick<EvalServices, 'checkTarget'>`; Track A's context and endpoint types must be accepted by it, and results must match in both directions.
- `ReturnType<typeof createBranchServices>` is assigned to `Pick<EvalServices, 'createJobBranch' | 'deleteJobBranch'>`, with parameter and result types equal in both directions.
- Shape pins for the gaps below (the `rerunFinding` parameter list, `deleteJobBranch(branchId)`, boolean-only `RunResult`, numeric `budgetMicroUsd`, no run/branch keys on `Finding`, and the current `EvalServices` names, including `proposeAndVerifyFix` and optional `getJobBranchConnection`).

I verified these catch drift by running against unreferenced commits with mutated `services.ts` (a `model: number` change, a dropped `url`, a changed result type, an extra branch result field, an extra `deleteJobBranch` parameter). Each failed type-checking.

## Runtime checks

Baseline checks cover pilot prices, job budget caps, finding statuses, a scenario with a state check, the shared suite cap, ASCII trace cap, `checkTarget` result schema, secret-free failure details, branch result shape, PostgreSQL-only branch URIs, ownership-based deletion, mapping of all twelve calendar acceptance scenarios into a valid `Suite`, and round-tripping their state specs through the grader's closed schema.

Contract update at `eee9939b290190886fa9aa11fd32ff84442f05f2`: Track A permits up
to 32 scenarios for 12 designed cases plus its red-team pack. The boundary check
now accepts 32 and rejects 33. Track B's frozen text engine still requires exactly
12 designed scenarios; this compatibility check does not establish execution,
remediation or reporting support for Track A's appended red-team cases. That
composition requires separate integration acceptance.

### Pinned gaps

Tests titled `KNOWN GAP` assert that a gap still exists. If Track A fixes one, that test fails on purpose; update the test and this table together. Nothing here is a Track B claim that the gap is acceptable.

| Gap | Observed in the contracts | Required Track B / integration behavior |
| --- | --- | --- |
| UTF-8 trace cap | `IntakeInput.trace.max(MAX_TRACE_BYTES)` counts UTF-16 code units. `'€'.repeat(204799)` parses but is 614,397 bytes. | Engine independently enforces `Buffer.byteLength(trace) <= 200 KiB` before use. |
| Short suites | `Suite.scenarios.max(32)` accepts zero or one scenario. | Engine requires twelve reviewed scenarios for ordinary jobs and records deliberate reductions. |
| Finding association | Zod strips `runId`, `branchId`, and `versionLabel` from `Finding`. | Persist run/branch/version links separately; do not rely on `Finding` to carry them. |
| Unknown cost | `CostEntry.microUsd` is a non-negative integer; `null` is rejected. Unknown judge cost cannot be represented as a monetary entry. | Preserve usage separately until billing reconciliation supplies a known cost; never fabricate a zero-dollar entry. |
| Run outcomes | `RunResult.results[]` has only `passed`, `detail`, and `scenarioId`. Calendar stop reasons `complete`, `target_error`, `invalid_response`, and `round_limit`, and monitoring outcomes (`passed`, `failed`, `inconclusive`, `infrastructure_error`), collapse into one boolean. `FindingStatus` has no infrastructure status. | Keep rich outcomes internally; extend the contract before showing infrastructure errors or inconclusive checks as product results. |
| Endpoint validation | `EndpointConfig` accepts URL credentials, non-443 ports, queries, fragments, `localhost`, private/mapped/encoded loopback addresses, a bare origin with no completions path, and API keys containing whitespace or control characters. | Run `checkTarget` before payment. Its transport refuses these with short codes (`invalid_endpoint`, `blocked_address`, `invalid_credential`); do not treat schema validity as endpoint safety. A bare origin is not completed to a path. |
| Scenario state | `Scenario` has no seed or actor field. Parsing silently drops them. | Resolve the frozen seed and actor from durable job storage, never from finding text. |
| Branch results | `deleteJobBranch` returns `void`, with no pending result variant; Track B now throws `BranchCleanupPendingError` until confirmation. `createJobBranch` cannot return a creating/reconciliation state. | Retain ledger state and surface explicit errors. |
| Pins not in runtime tests | `ServiceContext.budgetMicroUsd` is a number, not a reservation. `rerunFinding` has no credentials or frozen state. `deleteJobBranch(branchId)` carries no job authority. | Supply durable reservations; resolve credentials and state from authorized storage; verify branch ownership. |

## Limitations

- These are type and local behavior checks with pinned imported Track A support modules. They do not establish full current-application composition, live Naïve/provider behavior, or deployment acceptance.
- All Track B source directories are present and selected by the default run. The contract components remain deliberately narrower than dedicated engine/service/recovery acceptance suites; passing these shape and behavior checks does not prove that the app invokes every implemented service correctly.
- Test files import via paths that resolve only after staging (`../contracts/index`, `../targets/index.js`). They are not meant to be run from `tests/track-b/contract-checks/` directly.
- Contract digests cover only `.ts` files under the contracts directory at the selected revision.
- The check does not fetch; an out-of-date local `origin/track-a` is validated as-is, and the printed SHA is the source of truth.

## Track A contract update

Track A added required `proposeAndVerifyFix` and optional `getJobBranchConnection`, plus optional report-input remediations. The service-name pin now recognizes these additions; this shape check alone does not establish remediation integration. A secured remediation engine and owner-applyable Workflow composition now exist; current application adoption is tracked separately. The existing safe Neon connection resolver supplies the underlying branch lookup capability, with final platform wiring still required. Track A app conformance tests import its `@/server/services` alias and must run in that app workspace; the isolated Track B harness stages contract definitions, excludes Track A test files, and runs all selected Track B compatibility tests. Consequently test totals no longer include incidental Track A tests.

## Current verification setup

The current shared runner follows parsed imports, stages exact A support blobs from the supplied revision, and accepts existing dependency directories without installing or mutating them. See [the current harness documentation](track-b-harness-current.md) for reproducible offline commands. The original setup examples above require usable local dependencies; the present checkout's default dependency tree is incomplete. Dedicated sandbox/native PostgreSQL acceptance suites run separately from the 68-file default selection. Known gaps below remain real contracts to bridge, not permission to discard rich evidence, unknown cost, current authority or exact replay identities.
