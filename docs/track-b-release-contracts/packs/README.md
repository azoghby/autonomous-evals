# Appended pack release contract checks

Owned scope: `tests/track-b/release-contracts/packs/**` and this directory only. No implementation fixes. ECC and delegation disabled. Sources inspected at parent `6ff8a0642fc14dfd23842456d124a4b84f5e040a`; Track A contract/red-team source pinned to local `8634ceb30f3d98de7ec24b240a4f7549dce80033`. No fetch, installs, providers, cloud, secrets, deployment, or external services.

Combined strict scoped integration entrypoint, from repository cwd:

```sh
node tests/track-b/release-contracts/packs/run.mjs --strict
```

Default mode is also strict. Exit zero requires type checking, exactly two files and 19 passing tests, with no skipped/todo/expected-failure tests. Current **expected exit is 1: 15 acceptance passes and four release blockers**. Do not swallow that status in the parent's combined gate.

Diagnostic characterization only:

```sh
node tests/track-b/release-contracts/packs/run.mjs --characterize
```

Current result: exit 0, strict TypeScript passes, 19/19 tests pass, zero skips/todos. Four of those tests deliberately confirm current coverage gaps; this mode is NOT release acceptance. Also verified this invocation from `tests/track-b/release-contracts/packs` using `node run.mjs --characterize`. The runner resolves the repository from caller cwd and anchors subsequent Git reads at that root.

Dependencies are existing offline `/tmp/autonomous-evals-checks.m10du4/node_modules`; override with `TRACK_B_REVIEW_NODE_MODULES=/absolute/existing/node_modules`. No package manager is invoked. The runner copies current Track B source and pinned Track A contract/red-team source into a disposable temp directory, type checks them, runs only these two test files, then removes the temp directory. It copies the existing text fixture helper, not its test suite. Required transitive modules include TypeScript, Vitest, Zod, and the existing core dependencies. The temporary cache path is machine-local and may expire; missing dependencies are a hard failure.

## Actual boundary evidence

The pinned Track A `redteam/select.ts` executes `appendRedTeamToSuite` against a real parsed shared Suite: 12 designed cases become 20, including eight library-backed `rt_*` cases. Tests recover library definitions and render attack turns; these are not invented pack IDs. `contracts/index.ts` allows up to 32 shared scenarios. The current engine frozen suite is a different format containing only the 12 designed cases. No new pack implementation exists in this checkout.

Fifteen acceptance checks exercise real production functions:

- Pinned append/serialization and library recovery (one check).
- Comparison and monitoring reject full appended, single appended, duplicate, and replaced inventories with `rejected_input`, `retryable:false`, before checkpoint claims or either dispatch (eight checks).
- Rich run validation rejects omitted/duplicate engine scenarios (two checks).
- Check comparison rejects full-to-truncated inventory rather than taking an intersection (one check).
- Progress rejects 12-case run evidence when the trusted plan lists all 20, and rejects unsupported `pack_run` before durable reading (two checks).
- Explicit unresolved report state suppresses the clean conclusion in JSON summary, Markdown, and HTML (one check).

## Four strict blockers and minimal reproductions

Each is executable in `gaps.test.ts`, with current behavior checked by characterization mode and desired fail-closed behavior checked by strict mode.

| ID | Real entrypoint / minimal input | Observed behavior | Required integration boundary |
| --- | --- | --- | --- |
| PACK-REPORT | `reporting/render.ts:renderReport`, empty findings, 20 authorized IDs versus 12 executed IDs in details, omitted `evaluationStatus` | Clean “No problems were found” summary; status null; details are carried without coverage validation | Bind complete authorized inventory to report evidence or require unresolved status before rendering |
| PACK-SERVICE-REPORT | `evals/service-adapter.ts:createTrackBServices().renderReport`, authorized text intake, empty findings, operator disabled, no inventory/run evidence | Resolves a clean customer-contract report and monitoring pitch without an agent call | Authoritative execution/pack coverage must precede contract report generation; current contract cannot express it |
| PACK-PROGRESS | `reporting/chat/projection/index.ts:createDurableProgressProjection`, trusted resolver plan and completed run both omit eight appended IDs, durable job status delivered | Delivered snapshot, 12 passes, zero blockers | Trusted resolver must load complete application inventory including packs; the projector cannot discover omissions independently |
| PACK-COMPARISON | `monitoring/composition.ts:richChecks` then `compareRichChecks`, two identical 12-case base-only artifacts | 12 paired passes, zero unresolved, delta 0 despite application inventory having 20 cases | Composition resolver must carry all IDs; the low-level comparator alone cannot establish application coverage |

The comparison and progress cases are **missing integration guarantees**, not proof that the documented trusted resolver contract is violated by a deployed application. Their strict assertions deliberately block using these lower-level paths as complete-pack acceptance. Do not fix the generic comparator to reject every valid base-only suite. When pack delivery supplies the authoritative integration path, update the scoped tests to call that real boundary and keep the omission attacks. Do not convert strict blockers to expected failures or acceptance of base-only coverage.

## Limits and handoff

No engine, pack, Track A app/platform/contracts, SQL, or team-owned integration paths were modified. No new pack execution was fabricated. The test transports/checkpoint spies and progress reader are synthetic local ports; validators, append logic, renderer, service adapter, and projection are real code. SQL execution, actual pack targets/grades/reproductions, calendar-pack end-to-end behavior, durable resolver completeness, authorization implementation, live provider outcomes, and deployed release wiring are not certified. This task requires code evidence, so it does not create a redundant SQL suite.

Future pack-team acceptance should prove all 20 inventory identities survive run evidence, both comparison sides, reports, and progress; cover duplicate, missing, substituted and unsupported cases, and preserve unresolved/infrastructure outcomes. That work belongs to the pack/integration owners. No edit was made to `evals/packs` or `tests/track-b/pack-integration`.

Exact captured output is in `strict-results.txt` and `characterization-results.txt`. Both include source pin, dependency path, mode and test counts. Strict failures are intentional evidence of the current release gap, not harness skips.
