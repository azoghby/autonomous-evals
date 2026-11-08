## Parent fixes

Report cost rows are now detached from caller-owned input. Calendar A5 selects the running phase explicitly rather than relying on opaque reference sort order. The combined strict cross-service check passed 15 tests across four files after these changes. The ordering fixture still demonstrates why the former positional assumption was invalid; it is no longer an open A5 assertion defect. The original review evidence follows.

# Track B cross-service release evidence

Baseline: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`. Four children ran in separate T3 worktrees using Codex Sol `gpt-6.1-sol`, high reasoning; no further delegation and no ECC. Lead integrated all four commits and composed one scoped runner. Only `tests/track-b/cross-service-release/**` and this document changed. Production and original tests remained read-only.

## Combined result

```sh
node tests/track-b/cross-service-release/run.mjs > tests/track-b/cross-service-release/results.txt 2>&1
```

Exit **0**. Strict TypeScript passed; **15 tests passed across four files**, zero failures, skips, cancellations or todos. Text node:test: 2; Calendar Vitest: 5; Costs Vitest: 6; Ordering Vitest: 2. Classification: **12 acceptance, one regression, two characterizations**. Green characterizations do not mean the characterized problems are fixed. No broad fixture suite was run.

The runner compiles all scoped cases together, then executes the existing node:test and Vitest wrappers sequentially, one worker. It uses unchanged local production factories and SQL migrations, actual durable adapters, and deterministic external-service fixture ports. The ordering case retains its child runner's `src/` staging layout through a symlink to the same production source. No source rewriting occurs. Raw combined output: `tests/track-b/cross-service-release/results.txt`.

The source tested was integration HEAD `c0464ad46241fcacc8d5367b331e2cf6cf471f2e` (production identical to baseline). This checkout lacks Track A contracts. The combined run stages contracts read-only from already-local commit `8634ceb30f3d98de7ec24b240a4f7549dce80033`. Dependencies came from existing `/tmp/autonomous-evals-checks.m10du4/node_modules`. Override `TRACK_B_CONTRACT_REF` and `TRACK_B_REVIEW_NODE_MODULES` to select other existing local resources. No fetch or install is performed.

## Evidence and readiness

| Area | Result | Boundary exercised |
| --- | --- | --- |
| Text | 2 acceptance passed | Real service factory and agent/task/budget/checkpoint SQL; pending investigation blocks reports, disk reopen resumes the same session, committed findings agree with report and private chat, immutable early replies/history/cursors survive reopen; pending target intent prevents redispatch. |
| Calendar | 5 acceptance passed | Real Calendar factory, simulator, journal and checkpoint SQL; run/scenario/branch/suite identity survives investigation, report and progress; original/reproduction infrastructure errors remain unresolved; drifted trusted inventory is rejected; clean target is a positive control. |
| Costs | 5 acceptance + 1 characterization passed | Failed, pending, budget-paused and needs-input services retain terminal measured costs across disk reopen and replay; lost cost acknowledgment retries the same idempotency key without duplicate settlement or dispatch; report snapshot alias reproduced. |
| Ordering | 1 regression + 1 characterization passed | Actual Calendar run/investigation and progress SQL reproduce both opaque reference phase orders; selecting running outcomes by phase works for passing and failing targets; replay sends nothing further. |

**Readiness: local cross-service evidence passes, but unconditional release sign-off is withheld.** Report JSON cost immutability has a demonstrated defect requiring production-owner disposition. The old Calendar A5 assertion requires a fixture repair before it can serve as a stable release gate. Application route/wiring, deployed database concurrency and live providers remain unverified here.

## Parent handoff: production defect

`packages/core/src/reporting/render.ts:113` assigns `entries: input.costs ?? []`, retaining caller-owned rows. Minimal executable repro: `reportSnapshotCharacterization(path)` in `tests/track-b/cross-service-release/costs/cases.ts` reads measured costs from durable SQL, renders the report, then changes `costs[0].microUsd` from 125001 to 999999. JSON entries change, while `knownMicroUsd`, Markdown and HTML retain the original amount. An independent SQL read remains 125001, isolating the renderer alias. The characterization explicitly asserts the current inconsistency; it is not acceptance of immutable snapshots. Minimal fix direction: snapshot the array and cost rows in the production renderer. No production edit made.

## Parent handoff: Calendar assertion flaw

Inspected `d1459058f684dfd4dc3b2737a2110d63848166c3` read-only. Its live-acceptance offline A5 failure points to `tests/track-b/integration-acceptance/acceptance.test.ts:228`: `progress.phases[0]` assumes the running phase. Production projection sorts phases by opaque HMAC evidence reference (`packages/core/src/reporting/chat/projection/index.ts:239`). A passing investigation correctly has empty outcomes and can sort first. Random run/scenario identities affect checkpoint digests and therefore ordering; cross-test execution order was not established as the cause.

Minimal repro: `calendarPhaseOrderingCase(true)` in `tests/track-b/cross-service-release/ordering/cases.ts` executes the actual frozen twelve-scenario factory, then varies only a local reference key over unchanged persisted artifacts. Both first-phase orders occur; the legacy positional assertion fails in one. The failing-target control (`false`) also observes both orders but retains product failures. Reversing inventory does not change projection; replay has zero extra dispatches. Minimal repair for this single-run plan: select `progress.phases.find(p => p.phase === 'running')` and assert its outcomes. Do not weaken Calendar state grades or change production sorting. No original test was modified.

## Integration lineage

| Child | Original commit | Integrated commit |
| --- | --- | --- |
| Text | `b5e85f9d270b8c695d3e5b4755fb546b9ea16f03` | `5411c7e` |
| Calendar | `e233c33f7652d26ff54ac50c6f9840fe3555f3d4` | `c0464ad` |
| Costs | `b51b301a0988f784cf7f4571847908459e57e00f` | `e8540e6` |
| Ordering | `58bdb5aec9515fa36889ff9aa521d8c601dd4733` | `ae66566` |

Each child directory contains its precise case descriptions, commands and limitations in `FINDINGS.md`, plus its original captured results. The combined output supersedes separate contract/dependency choices for the integrated conclusion.

## Limits

PGlite executes genuine SQL and migrations but is not native multi-session PostgreSQL. Calendar advisory lock functions are intercepted; lock contention, OS process crashes and deployed isolation are not proven. Text/Costs close and reopen disk databases in process; Calendar recreates service adapters on its local database. Local external-session scripts model provider continuity. Trusted job status, inventory, authorization and the cost sink are fixture ports; the cost sink uses the real SQL checkpoint adapter. Exactly-once sink behavior depends on honoring session idempotency. Pending interim usage is not claimed as a settled cost. Text findings are checked through actual private chat; Calendar evidence reaches the progress projection, not a deployed chat route. All tests use actual production factories rather than fabricated service result shapes.

No provider/cloud/network calls, secret access, spending, outreach, deployment, push or PR. No other teams' owned paths changed. Out-of-scope fixes above are reports for the parent, not silent production changes.
