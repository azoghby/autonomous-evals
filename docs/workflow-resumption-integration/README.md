# Durable human-review resumption

Owner-applyable application patch, based on parent `687b508` and the exact
`docs/complete-workflow-integration` composition. No owner app/core/contracts files
are edited in this checkout. No ECC, notification delivery, providers, installs,
cloud changes, migrations, deployment or spend were performed.

`node docs/workflow-resumption-integration/verify.mjs` stages the predecessor's
pinned archive, checks/applies `resumption.patch`, compares every proposed file to
`source/`, strictly typechecks transitive real app sources against installed
Workflow dependencies, and runs the previous combined suite plus recovery tests.
`build-patch.mjs` regenerates the patch against that predecessor, never a checkout.
Existing offline dependencies default to `/tmp/workflow-bootstrap.JpxCTM`; use
`WORKFLOW_INSTALLED_WORKSPACE` to override. No dependency installation occurs.

## Lifecycle

1. The rich driver distinguishes `review_pending`, `agent_pending`, and
   `cost_delivery_pending`. Only human review suspension keeps the original
   Workflow alive. Its existing hook and physical Workflow run remain unchanged;
   target suite/run/branch identities remain those of the existing producer.
2. `humanDataReview` still requires the existing authenticated independent operator,
   same-origin JSON intake, immutable request snapshot and all core review gates.
   It now runs receipt claim/completion, canonical review claim/completion, and
   keyed intent insertion inside **one pinned transaction**. Core ledger-local
   transaction callbacks flatten into that outer transaction; failure propagates
   without callback retry. A failed intent write rolls back the review too.
   POST retry after a lost HTTP acknowledgement reuses immutable ledger writes.
3. `jobWorkflow` uses supported `workflow.sleep('30s')` and fresh durable
   `reviewWakeStep` calls while waiting. It does not reuse the already cached
   pending step result. A canonical review and scoped intent wake a new rich-step
   invocation. That invocation goes through the existing data advancement,
   immutable approved-suite admission, budget, permission, accounting and target
   gates. A rejected review cannot authorize evaluation. A changed/terminal job
   stops the waiting workflow. Secret/permission changes are screened by core
   and actual service functions again before target dispatch.
4. Intents visible **before** advancement are acknowledged only after retained
   pipeline results return. New concurrent human submissions are excluded from
   that acknowledgement. Old intents therefore do not spin the rich driver when
   another review becomes necessary. No checkpoint, provider claim, reservation,
   lease or partial evaluation is deleted.
5. Authenticated `GET /api/cron/review-resumption` examines at most 50 intents;
   `requireCronAuth` is the existing constant-time bearer check. Configure the
   owner's scheduler to call it on its usual recovery cadence. It re-enqueues
   only the exact existing run using the existing supported `reenqueueRun` API,
   rechecking hook ownership. Unknown liveness remains pending. Dead runs are
   retained as `needs_operator`; terminal jobs finish intents, while budget or
   scope changes hold them. No notifications or replacement workers are created.
   Timer polling also resumes review when no cron wake arrives.

The atomic path closes crash-after-review-before-wakeup. A dropped queue message
is recoverable by the bounded dispatcher; a replayed worker follows durable SDK
step results and retains the same identities. Provider ambiguity is still handled
by the existing core ledger, which refuses automatic redispatch.

## Owner application and migration order

First assemble the exact predecessor composition documented in
`../complete-workflow-integration/README.md`. Install its migrations in that
specified order, including data operations and `003-workflow-data.sql`. Then
install `source/apps/web/migrations/004-workflow-resumption.sql` with a unique
release migration identity, server-only grants and no public role access, **before**
shipping the patch. Check/apply `resumption.patch` at the assembled source root.
The stager verifies identical resulting bytes. Do not apply this patch directly
to an uncomposed Track A checkout. Review the final Workflow compiler/build and
hosted PostgreSQL concurrency behavior before release.

## Explicit boundaries

This closes review suspension for runs admitted with this Workflow definition.
Already terminated **old-definition** runs cannot be revived by re-enqueueing:
their durable pending step result is terminal. They require an explicitly reviewed
migration/restart procedure, not an automatic new worker. The dispatcher never
calls existing `restartJobWorkflow`, whose physical-run rewrite and old-definition
replay are outside this artifact's safe admission scope. Do not use that generic
restart route as a review-completion endpoint. Likewise pre-release reviews
written without the atomic intent need explicit migration/reconciliation; do not
infer provider outcomes from a receipt or invent confirmation to clear a claim.

This is not provider-session, budget or cost reconciliation, and does not repair
ambiguous core operations. Human rejection/revocation stops authorization rather
than completing an evaluation. No live Workflow execution or native PostgreSQL
cluster was used: tests label the external Workflow API as scripted, use PGlite
for PostgreSQL SQL, and execute actual assembled app/core functions. Full hosted
Workflow compiler/replay and remote acceptance remain owner checks.

Final-composition team: apply this delta **after** complete-workflow composition;
its overlapping files are `data-production.ts`, `job.ts`, and
`steps/rich-evaluation.ts`. Preserve the richer team's packs/chat/remediation
changes when porting the small review loop, pending reason and atomic intake
hunks. Do not replace their entire files with these predecessor-based copies.
Comparison/monitoring ticks and their scheduling are separate.

Measured final verification: **140/140 passed, 16 files, no skips**, including 31
recovery cases; strict assembled-source TypeScript passed. The runner extends the
predecessor's disposable intake fixture with required job columns and migration,
and updates only its three expected pending labels. Original test artifacts are
unchanged. The first broad run exposed those fixture/label mismatches; the final
run passed after the fixture updates.
