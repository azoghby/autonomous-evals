# Durable calendar service integration

Import `createCalendarEvaluationServices` directly from
`packages/core/src/evals/calendar-integration/index.ts`. This additive factory
composes `simulator/workflow`, `PostgresWorkflowInvestigationJournal`, and the
existing `evals/integration/checkpoints` store. It creates no new persistence
tables or engine primitives, and makes no cloud/provider calls itself.

## Trusted parent wiring

```ts
createCalendarEvaluationServices({
  checkpoints, // PostgresTextCheckpointStore on the durable application DB
  journalPool, // SqlPool on that same durable application DB
  resolve: async (ctx) => ({
    job, targetVersion,
    branch: { jobId: job.jobId, branchId, targetVersion },
    dependencies, // CalendarWorkflowDependencies bound to this authorized branch
    reviewedSuite, // CalendarSuiteInput from trusted reviewed storage
    systemPrompt, knownSecrets,
  }),
});
```

The resolver runs for **every** public operation, including reads, replays and
report preparation. It must authenticate the caller, authorize access to the job,
load the reviewed suite and branch association from trusted storage, and construct
branch-bound dependencies. The factory checks job/context/environment,
`workflow_eval` package, reviewed-suite job, branch job and stable target version.
It cannot inspect a closure to establish the physical database/target behind it:
that binding remains the resolver's responsibility. Internal fixtures require
`job.isFixture`. Neither review approval/reviewer identity nor branch/target
identity is taken from a customer's scenario payload.

`targetVersion` must change whenever endpoint, model, credentials or configuration
changes. It is a nonsecret label (1–128 letters/digits/underscore/dot/colon/hyphen),
not an endpoint or connection string. Branch IDs allow letters/digits/underscore/
hyphen, 1–128 characters. Credentials stay inside authorized target/database
closures. Supply **all** known target credentials in `knownSecrets`. Existing
`containsSecret` checks reject recognizable credentials and known secrets before
checkpoint/journal saves and successful returns, including replayed evidence.
They reject evidence rather than clipping or silently redacting it. Simulator
branch storage is a separate engine-owned evidence surface: the parent must apply
its own access control/retention and safe target boundary there. Driver/resolver
errors at this boundary return fixed messages, without raw exception text.

Apply the existing artifacts through the parent's migration process:

* `evals/integration/migrations/001-text-integration.sql`
* `simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql`
* `simulator/migrations/001_calendar.sql` on the isolated simulator database

The first two belong in durable application storage, never a disposable simulator
branch. Checkpoint transactions must pin a connection and never retry callbacks.
The journal requires direct/session-mode PostgreSQL pooling and the durability
settings described in [workflow persistence](track-b-workflow-persistence.md).
Tenant identity is the authorized job's stable `customerId`.

## Workflow operations and identity

```ts
await api.freezeSuite(ctx, { suiteId });
await api.getSuite(ctx, { suiteId });
const request = { suiteId, operationId, versionLabel };
const run = await api.runSuite(ctx, request);
const investigation = await api.investigate(ctx, request);
const report = await api.reportInput(ctx, request);
```

`suiteId` and `operationId` are stable identifiers chosen and retained by the
parent Workflow. Requests contain no reviewed-suite body, target configuration,
job association or branch association. Freeze validates the trusted review and
all twelve scenarios through `freezeCalendarSuite` and stores the full body and
hash. The resolver must load that same reviewed artifact (including timestamp)
on subsequent operations. Checkpoints bind environment, customer, suite hash,
system prompt, stable target version, authorized branch association, and run
version/suite identity. Input drift rejects even completed replay; a new suite or
version evaluation requires an explicitly new stable operation identity.

The `calendar_run` claim is committed before calling `runCalendarSuite`. Random
engine run/scenario scope IDs exist only behind this durable stable identity.
Completed full rich runs replay after fresh service construction without target
calls. Competing callers see pending state. A failed intent acknowledgement aborts
dispatch. A lost completion acknowledgement can replay if completion committed;
otherwise pending/ambiguous state blocks re-execution. There is no automatic
claim expiry, release, retry or reset API. `TrackBPendingError` indicates a phase
owned by a worker; it does **not** authorize redispatch after worker loss.
`TrackBBlockedError` with `needs_operator` requires reconciliation. Never mint a
new operation ID merely to bypass an interrupted operation.

A target error already captured by the workflow engine remains a durable rich
`infrastructure_error`, with available partial transcript/state. It is unresolved
evidence, not product failure or permission to resend. Other scenarios can finish
under their separate engine scopes. Unknown claim assessments stay inconclusive.
No infrastructure error is converted into a failed product assertion.

Investigation uses the existing PostgreSQL journal with committed per-attempt
intent, immutable original evidence, and the engine's three-candidate/one-attempt
bound. The service additionally persists the entire final investigation,
including findings and reproduction evidence, under `calendar_investigation`.
Journal loads/saves receive the same secret checks.

The whole investigation phase claim is deliberately conservative: if a worker
dies or its result fails to persist, a fresh factory blocks, even when the journal
has enough evidence to reconstruct some findings. The journal's engine-level
pending-attempt recovery remains available to an authorized operator/parent
reconciliation path; this factory does **not** expose an automatic recovery/reset
endpoint. Operators must inspect checkpoint, journal and external evidence before
repair. There is no promise to recover a missing transcript, resume the remaining
run scenarios, fence an already running remote request, or provide exactly-once
external execution. Do not advertise whole-phase resumability.

## Report and monitoring boundary

`reportInput` requires a completed durable investigation. It returns the complete
suite, run, investigation and workflow findings, plus `status` (`completed`,
`unresolved`, or `needs_operator`), explicit limitations, and a monitoring
projection. Pending reproduction IDs require operator handling. Inconclusive
findings remain unresolved even when all original executions were determinate.
Confirmed findings still represent observed product failures, not a clean pass.
Export the rich JSON alongside any human-readable report; the engine's bounded
finding excerpts alone do not retain complete transcripts/checks.

Monitoring uses `calendar_workflow` per scenario with evidence IDs tied to actual
execution scopes: `passed → passed`, `product_failure → failed`,
`inconclusive → inconclusive`, `infrastructure_error → infrastructure_error`.
This preserves unresolved states and ties the projection to suite hash and stable
target version; it makes no significance or population-reliability claim.

Parent changes requested (outside this implementation's ownership): wire the
factory into Workflow and authenticated routes; retain stable operation IDs;
authorize/load reviewed suites and branches; apply migrations and manage pools;
persist/export report artifacts; and extend the report/Track A contracts for
workflow evidence. Existing `Finding.source` only admits text/trace sources, so
these findings must **not** be relabeled as text to call `renderReport`.
Likewise `toTrackAWorkflowRun` rejects infrastructure/inconclusive states; the
parent must preserve rich evidence and pause/extend the contract rather than
invent booleans. No app routes, contracts, root manifests or existing engine
modules were changed here. No new budgets, live target validation, branch
provisioning, report delivery or provider accounting is wired by this factory.

## Local validation

Selected strict harness (no contract refresh/network required):

```sh
npm --prefix tests/track-b run check -- --components evals,simulator --track-a-ref origin/track-a
```

The new integration tests execute all twelve simulator reference fixtures through
the actual runner, SQL grader, existing simulator migration, checkpoint migration
and durable journal migration in PGlite. Only advisory functions are intercepted.
PGlite queues a single backend; competing checkpoint callers exercise SQL claim
behavior, **not** native multi-session journal/advisory-lock proof. Native journal
and checkpoint evidence documented elsewhere does not establish a native
multi-session test of this new whole service. All targets are deterministic local
fixtures; there are no live provider/customer executions or spend.

Final selected validation on November 7, 2026: strict TypeScript passed and
**395/395 tests across 29 files passed, none skipped**, including **13 new calendar
integration tests**, against locally resolved `origin/track-a` commit
`e969708da6a2bee205fcff9f78faa5e242fdd3c3` (contract digest
`67a98dc7ddab55f56223fe40b402edae6bd0edbab4d4d070a19706fc006ae915`).
Dependencies were installed with `npm --prefix tests/track-b ci --offline` from
the local cache. An initial selected run passed strict types and 394/395 tests;
its sole failure was the new test's expected resolver invocation count (eight
instead of the seven public operations called), corrected before the green run.
No skipped tests, harness changes, external network/provider calls, native
PostgreSQL service run, or production migration execution are claimed here.
