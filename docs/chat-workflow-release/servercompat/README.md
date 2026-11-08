# Current-core server compatibility correction

Target: local core `48519bf`, Track A `f0068733ca49c37f40fd7de279325f21a4b5fbbb`, and the exact chat/structured/Workflow patches in `docs/workflow-integration/SERIES.json` at `5f513d1`. This is an additive application patch, not production integration or release acceptance. Production sources and original artifacts remain unchanged.

## Concrete correction

`0001-current-core-server.patch` supplies the existing data production intake and human review route, adapted from `docs/data-production-integration/intake/track-a.patch`. That original patch cannot apply after Workflow: its `buildAgentDeps` export hunk expects the old unverified Naive constructor, while Workflow already exports and hardens that function. The correction omits the conflicting hunk and retains verified pinned role versions, stable budget period and idempotency namespace.

The original intake also writes costs under its own job-row lock. That lock does not participate in Workflow's global cost-key transaction. The correction replaces that writer with `deliverProductionDataCost`, which validates measured, same-job, nonsecret evidence, converts it with the current core adapter, and awaits the existing `recordCost` -> `upsertWorkflowCost` path. Generation delivery, retained design-cost draining and immediate design-cost delivery all use this path. Key/amount/job/metadata conflicts propagate; no new retry identity, cost increment, reconciliation override or second ledger is introduced.

This installs the private intake seam; it does **not** connect data production to rich target execution. The existing rich driver still registers existing tasks and refuses them until an authorized frozen-suite admission bridge is implemented. The HTTP human-review route records authenticated review only and does not advance Workflow, invoke generation or approve on behalf of a model.

## Source application order

For a disposable archive or the parent's independently staged series:

1. Archive the Track A commit above.
2. Apply `docs/progress-chat-integration/combined.patch`.
3. Overlay the **current `48519bf`** versions of the seven core directories listed in `SERIES.json` (do not revert them to its older core pin).
4. Apply `docs/structured-progress-integration/backend/structured-progress.patch`.
5. Apply `docs/workflow-integration/service-bootstrap/0001-rich-service-bindings.patch`.
6. Apply `docs/workflow-integration/workflow-producers/002-workflow-producers.patch`.
7. Apply this directory's `0001-current-core-server.patch` with `git apply --check` followed by `git apply`.

Do **not** additionally apply the original data intake patch: its new files are included here and its incompatible export and separate writer are intentionally replaced. If those files were already integrated elsewhere, reconcile their content with this patch rather than forcing/reapplying it. There are no existing-source hunks in this correction; it cannot overwrite parent identity/citation/report work. Parent UI history/revocation/stale-response/retry corrections and webpack aliases/Tailwind corrections are independent prerequisites; this patch touches none of their files. Read-only historical evidence was inspected via `git show d7cd083:docs/chat-release-verification/README.md` and its runner; those artifacts are not silently added or claimed rerun here.

## Migration order for the deployment owner

No SQL was executed in this task or by the included test runner. Stop writers/workers and use the established deployment migration process, pinned transactions, rollback on failure and server-only grants. The original `001`/`002` prefixes belong to different schemas, not a global migration sequence.

1. Establish Track A's application schema (`jobs`, `customers`, `costs`, credentials), then `packages/core/src/agents/persistence-migrations/001-agent-persistence.sql`.
2. Install conversation tables once: `docs/progress-chat-integration/server/001-private-conversations.sql` is the transaction-wrapped equivalent of `packages/core/src/reporting/chat/persistence-migrations/001-conversations.sql`; do not run both.
3. Install `packages/core/src/evals/integration/migrations/001-text-integration.sql`.
4. Install `packages/core/src/evals/data/persistence-migrations/001-evaluation-data.sql`, then `002-data-operations.sql`.
5. Install `docs/structured-progress-integration/backend/001-structured-progress.sql`.
6. Before cost replay, reconcile historical keyed/unkeyed costs, then apply the series-created `apps/web/migrations/001-workflow-integration.sql`. It backfills global cost keys and creates bindings; duplicate keys deliberately abort. Do not delete costs or keys to force replay. A previous separate data writer must be stopped before this backfill and replaced before restarting.
7. Install `docs/workflow-integration/workflow-producers/migrations/002-rich-artifacts.sql` after the Workflow schema exists.
8. Install `packages/core/src/simulator/ledger-migrations/001_branch_ownership.sql` and `packages/core/src/simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql` in application storage. Install `packages/core/src/simulator/migrations/001_calendar.sql` only on the isolated simulator branch/database. Verify the actual database routing before enabling Calendar workers.

Wrap migrations without their own BEGIN/COMMIT in deployment transactions. Existing incompatible tables require schema inspection and explicit migration, not reliance on `IF NOT EXISTS`. Grant runtime table access without DDL or public/client access. Native concurrent PostgreSQL, migration/backfill execution and real Neon transport remain unverified here.

## Verification and limitations

Run from the repository root using **existing** workspace dependencies only:

```sh
node tests/track-b/chat-workflow-release/servercompat/run.mjs
```

Override `SERVERCOMPAT_INSTALLED_WORKSPACE` to an already installed Track A workspace (default `/tmp/workflow-bootstrap.JpxCTM`). This command archives local commits, reproduces the original export-hunk refusal, checks/applies the correction, runs seven tests of the actual applied cost helper with a mocked canonical sink, then typechecks server sources, Workflow sources and the human-review route against actual installed SDK packages and current core. It does not install, build, generate Next routes, execute SQL, retrieve secrets or call a provider. `stage.mjs --corrected` only constructs an archive and checks/applies patches.

Validated: seven tests passed; targeted strict TypeScript passed. The broad initial server glob also picked up two preexisting Track A test-only typing errors (`monitoring.test.ts` ID union and `x402-pay.test.ts` callback variance); production checking excludes `*.test.ts`. No tests were edited or weakened to hide these errors. Sink transaction atomicity/concurrency is not proved by the mocked test and no SQL tests were run.

Current core adds durable data and reviewed pack primitives but does not supply their complete Workflow admission, inventory, evidence and reporting bridges. `REDTEAM_PACK=off` remains required for frozen12; appended paid scope is refused, never silently truncated. Preserve every pending/review/cost/freeze/reconciliation state and immutable task/suite/run identity. Only authorized ready+frozen data with retained provenance can later enter an admission bridge; independently redesigning or inventing checkpoint keys is not a bridge. Remediation, Gateway metering, monitoring dispatch, live authentication/revocation, full app builds and deployed acceptance remain separate gates. The conservative core safety screen can also refuse numeric-looking identifiers as PII; this correction preserves that fail-closed behavior.
