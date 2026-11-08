Run `node tests/track-b/current-autonomy-calendar/run.mjs` from the repository root.
`--tests-only` omits the production Next/Workflow build. The runner stages the candidate and
calendar patch into a temporary directory and compiles the actual applied application/core.
It only uses installed offline dependency and retained font caches; override
`WORKFLOW_INSTALLED_WORKSPACE`, `AUTONOMY_NODE_MODULES`, and `CHAT_FONT_CACHE` when needed.
It does not copy `.env` files and guards outbound sockets/fetch.

The optional `CALENDAR_RETAINED_STAGE` points to an unchanged earlier candidate stage.
The owned staging script verifies its bytes against the historical preservation and
application manifests before copying; this is the fallback for unavailable Git objects.
`CALENDAR_STAGE` skips staging and uses an already applied temporary source tree.

The new suite runs the actual current `createRichWorkflowServices`, issued paid capability,
checkpoint store, reservation ledger, inventory publisher, branch ownership ledger,
calendar engine, SQL simulator, graders and investigation journal. Only the decrypted
job lookup and provider/Neon transports are scripted. All twelve controlled reference
scenarios execute real simulator SQL. Tests cover reconstructed services, changed
Workflow/target/job/environment/branch identity, mutable caller objects, unknown-cost
holds, verified keyed receipt reconciliation, exhausted shared budgets, product failures,
lost replies, and failed whole-phase completion without redispatch.

Limits: single-backend PGlite intercepts advisory lock functions. Reconstructed services
retain the SQL instance; these tests do not simulate a separate OS process or prove
native PostgreSQL multi-session locking, hosted Workflow recovery, provider behavior,
actual provider billing, a clean dependency install, or cloud branch deletion. Disposal
closes only the service's simulator pool and retains application branch ownership rows.

Early fixture runs exposed missing partial mock exports and invalid fixture cap settings;
those fixture setup errors were corrected before the final recorded verification.
