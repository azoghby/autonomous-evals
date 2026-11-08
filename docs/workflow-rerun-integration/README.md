# Finding rerun extension (offline, owner-applyable)

This extension is pinned to **883d186a94ea38aeb122afeb9d9e9bd2ee0c6e24**,
`docs/track-b-final-composition/stage.mjs`: full A `530af320…`, current B/core
`687b5086…`, approved data, remediation, packs, marketing and cloned-plan fix.
It does not replay an older core overlay. Implementation checkout parent is
`01cd322b18dbfd5067323fba051c633d55151574`. Only this documentation tree and
`tests/track-b/workflow-rerun-integration` are edited. No ECC, network, provider,
cloud, secrets, spend, deployment, executed migrations, outreach, push or PR.

## Apply and reproduce

1. `node docs/workflow-rerun-integration/build.mjs` runs the exact final stager
   from a disposable **git archive** of the pinned commit. Its integrity checks
   remain enabled. The small local Git shim redirects read-only object reads to
   the existing repository; patch application stays in disposable directories.
   No new worktree or checkout is registered. All dependencies are already local.
2. Review `rerun.patch`, `SERIES.json` preimage hashes and `source/` review copies.
   Apply **after** the final application artifact, using `git apply --check` and
   `git apply` in the owner's independently authorized checkout. Never replace
   current sources wholesale with the review copies. Application runs no SQL.
3. `node tests/track-b/workflow-rerun-integration/run.mjs` reconstructs the final
   stage, proves all upstream files outside the six extension paths are unchanged,
   reverses/checks/applies the actual distributable patch, checks strict transitive
   TypeScript of the service/action/HTTP/MCP entrypoints, then runs local tests.
   Existing `/tmp/workflow-bootstrap.JpxCTM` dependencies are used; override
   `WORKFLOW_INSTALLED_WORKSPACE` to another existing installed tree. No install.

`RESULTS.json` under the test directory is the measured extension evidence. It
covers real applied functions with real PGlite SQL, durable checkpoints, the
actual Text and Calendar rich factories, local scripted targets and real Calendar
SQL grading. Transport tests execute actual HTTP/MCP functions with the shared
service mocked to inspect their identical owner/key forwarding. This is offline
fixture evidence, not provider execution or hosted PostgreSQL concurrency proof.
Upstream's 205 tests/build are upstream evidence; this extension does not claim
that those tests or a final Next/Workflow build were rerun here.

## Execution and authorization contract

HTTP POST requires `Idempotency-Key` matching `[A-Za-z0-9_.:-]{8,128}`. MCP
`rerun_finding` requires the same `idempotencyKey` at execution; the field remains
schema-optional so old clients receive the shared explicit missing-key error.
Keyless clients fail without dispatch; there is no generated-key or legacy-service
fallback. Keys are scoped to the job across both transports. Retry the **same** key
for the **same** original finding and unchanged authority. A new deliberate rerun
uses a new key, up to three per original finding including pending, ambiguous and
historical legacy saved reruns. A changed finding or credential/target/branch/
Workflow/retained artifact/hold under an existing key is a conflict. Rotating a
credential or target requires a new deliberate operation, never replay takeover.

Both transports pass the authenticated owner identity, not a request-body owner.
The service reloads owner/job/delivered state/current ciphertext/Workflow binding/
environment/target revision and the private immutable rich artifact in SQL. Even
an operator viewing somebody else's job cannot dispatch using operator visibility.
The original findings row supplies only the association key; its lossy JSON,
response quotes and any submitted scenario are never execution authority. Rerun
rows are not accepted as original findings. Missing/deleted credentials, revoked
job state, missing reviewed suite, unavailable original branch or wrong branch
ownership fail closed. Calendar never creates a replacement branch. The branch
must equal the retained baseline branch, and current ledger ownership/readiness
is checked at resolution and each target call. Both target adapters recheck
current job/owner/credential/environment/version before every request. Initial
`checkTarget` still runs before dispatch. The rich factory's IntakeInput parsing,
approved-suite admission, known-secret scans and target policies are preserved.

Only unappended frozen12 Text/Calendar baseline artifacts are supported. Text
uses `text.rerun` with the immutable original baseline run, and executes all twelve
baseline scenario IDs. Calendar re-freezes the **same trusted reviewed suite**
under the new operation/target identity, verifies full equality with the retained
suite, and runs all twelve in distinct simulator scopes on the existing owned
branch. This permits deliberate target-version changes without trying to reuse a
baseline checkpoint bound to an old target. The finding selects the operation's
association, not an invented one-case suite. Returned checks, rubric assessment,
infrastructure errors and Calendar product/state outcomes remain full rich
objects. No boolean conversion, trace-to-endpoint reproduction, inherited
reproduction claim, investigator call or fix-verification claim is made. Trace,
comparison, benchmark, monitoring jobs and appended-pack artifacts explicitly
refuse; a base12-only result cannot claim to retest appended scope.

## Durable intent, cost and recovery

Job-row locking serializes admission across different keys. In that transaction,
read existing operation first, count pending plus completed plus legacy rows,
check known costs/open application reservations/all retained rerun holds against
existing package caps, and persist the new pending operation **before** target
construction or dispatch. A positive server-reviewed
`bindings.rerun_operation_micro_usd` is required; missing binding is not unlimited
budget. The operation context is capped to this hold. Holds stay reserved even
for completed HTTP execution because provider monetary totals remain unknown;
no invented zero price, automatic release or optimistic reconciliation is used.
This is deliberately conservative and can block further work until reviewed.

Same-key concurrent requests observe the same stable operation ID and pending or
completed result; only the insertion winner executes. There is no lease expiry,
unknown-claim takeover, automatic retry after restart, or new branch/run on retry.
Any interrupted/failed execution becomes `needs_operator`; a hard crash may leave
`pending`. Both are explicit reconciliation states. If completion committed but
its acknowledgement was lost, completion is never overwritten; replay returns
the committed result without target/cost duplication. The first failed response
can conservatively say `needs_operator` until replay reads committed completion.

Operator reconciliation must inspect the exact operation row and core durable
checkpoint/target receipts. Do not reset/delete the claim or decrement count/hold
because a worker is old. A verified committed result may be adopted only with
matching operation/input/authority and secret-scan checks; unknown dispatch
remains blocked. A separately authorized reconciliation tool and authoritative
provider accounting are deployment gates, not supplied automatic recovery here.

## Results and migration identity

POST returns `{operationId,state,result,replayed}` (HTTP 200 completed, 202 pending
or needs_operator). Replay is the operation lookup. GET on the same finding rerun
route returns private rerun appendices; MCP `get_report` includes `reruns`. The
result has original finding ID/key, baseline run, suite digest, current target
version, separate report text, exact new suite/run and explicit limitations.
Private progress includes the stable rerun identity with fixed prose. The original
report, finding row, baseline binding, artifact and baseline run are never updated.

`MIGRATION.json` assigns **app.workflow-finding-reruns.006** to
`apps/web/migrations/006-workflow-finding-reruns.sql` in the application database.
It follows the final artifact's full canonical identities (rich artifacts,
remediation and packs). It must be appended to the owner's migration registry,
with checksum and server-only grants, as its own transaction. Do not discover it
by `004` or execute any final baseline migration twice. This artifact does not
edit the final-composition migration manifest or execute DDL. No simulator SQL or
seed runs here. The parent's read-only confirmation that Neon main/seed exist
provides no deployment or migration authorization.

## Final composition seams and unresolved checks

The six patch paths are rich-services, job-actions, MCP tools, rerun route, new
rich-rerun service and the uniquely named migration. There is no rich driver,
approved-data, pack approval, workflow-data/cloned-plan, core, contracts, package,
marketing or final-composition artifact edit. Factory changes add a narrow
owner/target-pinned delivered-job authority mode and fresh per-request checks;
normal Workflow authority and pack resolvers stay present.

Comparison `bf7e63a` and resumption `03cfde5` + `da5dda9` are separate extensions,
not applied by this stager. Their rich-services overlaps need an explicit merge:
retain their APIs/resumption fences and this delivered-owner mode/current target
checks. Do not copy either old complete service or core overlay over the merged
source. Their historical `004` SQL needs a distinct full canonical identity; this
extension already owns `app.workflow-finding-reruns.006`. Rebuild the final owner
artifact and refresh its inventory/migration manifest only in the parent-owned
composition task. Re-run all combined tests and full core/app TypeScript plus
Next/Workflow build after that merge.

Other unresolved deployment checks: real multi-session PostgreSQL locking and
cross-writer budget-reservation coordination, current credential/branch revocation
races in the deployed stack, reviewed positive budget binding, migration registry/
backfill/grants, client key adoption (existing UI must supply a stable key), private
appendix/report rendering, durable worker crash/recovery and receipt reconciliation,
reserved Gateway rubric judging and provider billing/controlled acceptance. A
successful SQL fixture is not proof of these gates. No deployment is requested.
