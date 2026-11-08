# Calendar phase ordering regression

Base: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`.
Inspected read-only: `d1459058f684dfd4dc3b2737a2110d63848166c3`, especially
`tests/track-b/live-acceptance/offline/results.txt` (A5: `[]` did not include
`passed`) and its separately passing `integration-results.txt`.

## Finding: fixture assertion flaw, not Calendar execution failure

`tests/track-b/integration-acceptance/acceptance.test.ts:228` assumes
`progress.phases[0]` is the running phase. Production
`packages/core/src/reporting/chat/projection/index.ts:239` sorts phases by
HMAC evidence reference, not phase chronology or checkpoint inventory order.
A completed, passing Calendar investigation correctly has `outcomes: []`.
When that phase sorts first, the old assertion fails despite all twelve
Calendar scenarios passing actual SQL state grades.

The investigation checkpoint digest includes the run artifact
(`evals/calendar-integration/index.ts`, `investigationKey`); run and scenario
IDs are random UUIDs (`simulator/workflow/index.ts`). Fresh artifacts can thus
change hash order with the same reference key. This is not established to be
a dependency on which Vitest test executes first. The no-op fixture masks the
flaw because its investigation also contains `product_failure`.

## Minimal executable repro and regression

Run from repository root (local dependencies only):

```sh
TRACK_B_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules node tests/track-b/cross-service-release/ordering/run.mjs
```

`results.txt` records the command's successful output. Strict TypeScript checks
the scoped cases and their production imports; exactly two tests run with no
skips. `calendarPhaseOrderingCase(fixed: boolean)` in `cases.ts` is an exported
async case for a combined lead runner. Stage it alongside `src/` (the same
convention as existing Track B runners), and call with `true` and `false`.
The runner defaults to the original local Track A contract commit
`f0068733ca49c37f40fd7de279325f21a4b5fbbb`; an optional first argument overrides it.

The production Calendar service factory freezes, runs and investigates using
real simulator, checkpoint and journal SQL adapters. A new PGlite database per
case prevents cross-test state. The freeze schema requires exactly twelve
scenarios, so a one-scenario booking repro is rejected; twelve is the minimum
valid factory input. Only this Calendar/projection seam is executed.

For unchanged persisted artifacts, a bounded local reference-key sweep must
observe both first-phase orders. Each order preserves run outcomes selected by
`phase === 'running'`, investigation outcomes, and running job status. Reversing
checkpoint inventory produces identical projections. Recreating services and
replaying run/investigation produces identical artifacts with zero additional
target dispatches. The characterization explicitly requires the old positional
assertion to fail for the passing target; this passing characterization is not
release acceptance.

Minimal out-of-scope repair: in A5, select the running phase and then assert its
outcomes, e.g. `progress.phases.find(p => p.phase === 'running')?.outcomes` for
this plan's single run. Do not change production ordering or weaken Calendar
state checks. No original tests or production files were modified.

## Limits

No provider/cloud/network calls, credentials, installs, deploys or broad fixture
suites. Local deterministic targets emit fixture reference calls or no calls.
PGlite is an embedded PostgreSQL engine, not a live multi-session PostgreSQL
server. Following existing integration conventions, the pool shim implements
only advisory lock/unlock acknowledgement; all journal data reads/writes use
production SQL. Lock contention, crash recovery, tenant authorization, deployed
chat/report delivery and live provider behavior are outside this check. The
local job row and trusted authorization resolver are fixture context ports.
