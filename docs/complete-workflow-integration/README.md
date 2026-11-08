# Complete Workflow: approved data + frozen12 remediation

Artifacts only, based on `ec123e9ebf1e83c27f8109102658d1554cb20fb5`.
No actual app, contracts, manifests or predecessor artifacts are changed. ECC is
unused. No install, network, provider, secret, hosted migration, outreach, push or
PR. The disposable archive contains executable proposed application source.

## Reproduce offline

```sh
node docs/complete-workflow-integration/stage.mjs
node docs/complete-workflow-integration/build-patch.mjs
node docs/complete-workflow-integration/verify.mjs
```

Verification uses `/tmp/workflow-bootstrap.JpxCTM` (override
`WORKFLOW_INSTALLED_WORKSPACE`) and existing `tests/track-b/node_modules` when
present (override `WORKFLOW_NODE_MODULES`); otherwise it uses the bootstrap's
already installed Vitest. No install or dependency resolution over the network.
`--typecheck-only` omits SQL tests. Tests run with one worker. Temporary archive
paths are printed/retained for inspection; these are not worktrees or deployments.
The stager checks SHA-256 inputs in [SERIES.json](SERIES.json), plus predecessor
checks. Core is immutable `e61ad9719a1f7cfc844523cffbd72253dcdcb30b`.

## Exact source application order

1. Run `stageBridge()` from `docs/workflow-data-bridge/stage.mjs` unchanged. This
   archives A `f0068733ca49c37f40fd7de279325f21a4b5fbbb`, applies combined chat,
   overlays original seven B trees at `5906961…`, applies structured progress,
   service bootstrap and Workflow producers, overlays data at `48519bf…`, applies
   intake excluding the already hardened `buildAgentDeps` export, adds approved
   admission, then applies `bridge.patch`. The predecessor README enumerates the
   full pinned hashes and order. This temporary intermediate source is intentional.
2. Replace **only** `packages/core/src/{agents,evals,judges,monitoring,reporting,
   simulator,targets}` with a clean archive of `e61ad971…`. Remove those seven old
   trees before extraction so deleted files cannot survive. Preserve A contracts,
   integration, DB, redteam and all other sources. This pin already has the
   approved-suite hook, accounting and stable Calendar operation IDs. Do **not**
   reapply the old Calendar/core producer hunks or the bridge service hook afterward.
3. Check/apply `docs/workflow-remediation-integration/app/003-remediation.patch`
   excluding exactly `apps/web/src/server/rich-services.ts` and
   `apps/web/src/workflows/steps/rich-evaluation.ts`.
4. Check/apply [combined.patch](combined.patch) to those two files. Review copies
   live under `source/`; the stager verifies exact resulting bytes. The patch is
   generated against step 3 by `build-patch.mjs`, not against the checkout app.
   Temporary three-way merge candidates were inspected; their two unresolved
   conflicts were resolved explicitly and the resulting delta reviewed.

The service returns text, Calendar, remediation, inventory, `advanceData`,
`approvedData`, baseline binding, disposal and reporting together. The Text driver
uses the admitted approved suite without designing it again, binds the saved
baseline and selects a confirmed objective failure for remediation. Private
`rich_text_remediation.v1` evidence retains suite/run/investigation, remediation,
`dataProvenance` (null only for design-only jobs), and the **same full limitations**
as report construction, including input assessment, frozen12 scope, unknown money
and remediation outcome. All pending/acquisition/inventory and Calendar behavior
is preserved. Appended packs still require `REDTEAM_PACK=off` in this composition.

## Deployment migration order (owner action, not executed)

Names below refer to the assembled source unless explicitly under docs. Repeated
001/002/003 prefixes are schema-local artifacts, not a global lexicographic order.
Assign unique release migration identities while retaining the exact SQL order:

1. Track A application schema (`jobs`, customers, costs, credentials), then
   `packages/core/src/agents/persistence-migrations/001-agent-persistence.sql`.
2. Conversations once: `docs/progress-chat-integration/server/001-private-conversations.sql`
   OR `packages/core/src/reporting/chat/persistence-migrations/001-conversations.sql`.
3. `packages/core/src/evals/integration/migrations/001-text-integration.sql`.
4. `packages/core/src/evals/data/persistence-migrations/001-evaluation-data.sql`,
   then that directory's `002-data-operations.sql`.
5. `docs/structured-progress-integration/backend/001-structured-progress.sql`.
6. Stop old cost writers; reconcile historical keyed/unkeyed identities, then
   `apps/web/migrations/001-workflow-integration.sql` (global cost keys/bindings).
   Conflicts abort; never delete evidence to enable replay.
7. `docs/workflow-integration/workflow-producers/migrations/002-rich-artifacts.sql`.
8. `apps/web/migrations/003-workflow-data.sql` (private plan/advance/ready evidence).
9. `packages/core/src/evals/remediation/accounting/001-remediation-accounting.sql`,
   then `apps/web/migrations/003-remediation.sql` (binding policy/provider costs).
10. For Calendar, install `packages/core/src/simulator/ledger-migrations/001_branch_ownership.sql`
    and `packages/core/src/simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql`
    in application storage; `packages/core/src/simulator/migrations/001_calendar.sql`
    only in isolated simulator storage, before Calendar execution.

Use deployment transactions where not already supplied; inspect existing schemas
and grant server-only access without runtime DDL. Pack SQL is **not** in this
series. Its separate `003-workflow-packs.sql` needs its own identity in a later release.

## Measured checks and limits

[RESULTS.json](RESULTS.json): **109/109 tests, 12 files, zero failures/skips** on the
actual combined archive; strict transitive TypeScript of data, approved admission,
remediation/accounting, rich Workflow and authenticated review/binding routes passed
against real installed SDK dependencies. The initial runner attempt stopped before
any tests because this checkout lacks `tests/track-b/node_modules`; the runner now
uses the authorized existing bootstrap fallback. No code/type/test failure occurred.

Tests: Workflow data 12; rich driver 8; real approved-service SQL 1; global costs 2;
data producer 5; authenticated review route 5; approved admission 10; app remediation
5; core remediation 23; secured remediation target 31; accounting 6; new cross-flow 1.
The new cross-flow executes the applied rich driver with mocked service ports,
proving approved-suite selection reaches remediation without redesign or loss of
provenance/remediation/limitations. Separate real PGlite/service/target tests in the
**same combined stage** cover durable data admission, frozen suite lookup, twelve
serialized remediation payloads, replay, authority refusals and accounting. This is
not one live end-to-end test, remote attestation, or standalone-green inference.

Real gates remain: trusted plan registration, authorized isolation/operation budget
binding, migration/backfill/private-role deployment, authenticated wakeup and
ambiguous-operation recovery, current-secret/revocation races, hosted PostgreSQL
concurrency, complete provider billing reconciliation (unknown amounts hold budget),
reserved rubric judging, full Next/Workflow build on the final composed release,
Neon/provider execution and controlled/live acceptance. Calendar remediation,
appended-pack remediation, monitoring/comparison dispatch and artifact revision
lifecycle are not supplied. Offline fixtures grant no production authority.

See [NEXT-SEAMS.md](NEXT-SEAMS.md) for the inspected pack/chat/controlled-target
composition boundaries. No pack implementation is changed here.
