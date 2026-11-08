# Workflow producer patch layer

Apply `002-workflow-producers.patch` after the existing private-chat and structured-progress layers and service bootstrap patch, on Track A `f0068733ca49c37f40fd7de279325f21a4b5fbbb` with core source prerequisite `5906961c2a70c0d6d2999cf7086689402ff60f5b`. The parent `../stage.mjs` composes exact archives and checks/applies each patch. Source copies under `files/` are review aids; `build-patch.py` deterministically regenerates the patch. No actual application or core file is edited by this artifact.

The real-mode Workflow dispatches single-version Text and Calendar through existing rich factories, preserving full frozen suite, run, investigation and limitations. It no longer converts unassessed/rubric/infrastructure checks to booleans. Missing reference text remains unassessed. Pending and ambiguous execution stop on retained durable work; budget stops persist `paused_budget`. No exception text enters customer progress. Fixed prose records the distinction between pending and operator reconciliation.

Stable suite/run IDs survive a fresh Workflow invocation. The tiny core patch permits the calendar aggregate run ID to come from a canonical SHA-256 of its job and parent operation ID, beneath the existing immutable checkpoint digest and claim. Individual calendar scenario partitions still use fresh isolated IDs. A changed input cannot bypass the durable operation identity. The existing persisted branch is reused after ownership resolution instead of being deleted on replay.

`workflow-inventory.ts` wraps the actual checkpoint store. It publishes the exact factory key before claim and after acknowledged mutations, under a locked authenticated job row. Text `run_identity` and `run_result` share the core input digest, allowing the expected result to be inventoried before target execution. Rich associations come from the frozen suite, canonical branch and stable operation identity; no checkpoint prose or customer-supplied digest selects them. Old associations cannot be retargeted. Failure to publish prevents dispatch/continuation. All inventory transactions finish before provider work.

Separate migration `migrations/002-rich-artifacts.sql` installs private, immutable rich evidence storage in the application database. There is no request DDL. The evidence route first uses existing session and job-viewer authorization, then joins the artifact against current tenant/job/environment. Current decrypted credentials are used only to refuse unsafe replay. A changed rich evidence payload fails rather than overwriting original evidence. The human report still uses existing private Blob/database persistence. The full JSON evidence becomes downloadable via the authorized evidence route instead of aliasing report Markdown.

The default appended32 red-team pack explicitly refuses execution. Deployment must choose `REDTEAM_PACK=off` for the literal reviewed frozen12 scope; richpack integration requires separately agreed engine/admission/report support. Version comparison does not fall into this single-version driver.

## Remaining code and acceptance

This patch is a bounded integration layer, not completion of every requested feature. No remediation is executed and no verified fix is claimed; reports explicitly state that limitation. Authenticated canonical finding/trial/baseline approval, priced target reservation/settlement and mandatory late usage/outbox accounting must be integrated before dispatching the secured remediation target. A proposed prompt is not a verified fix.

At this series' core pin, data production lacks its shared ledger/intake integration.
The later parent `66da7a4` now supplies the PostgreSQL ledger and authenticated
`advanceProductionData` composition; reuse it without duplicating those modules.
The remaining Workflow mapping/freeze provenance bridge and unified cost sink are
described in [parent compatibility](../PARENT-COMPATIBILITY.md). Any existing
evaluation-data task is inventoried and blocks this driver before design/target
execution. Even ready tasks cannot bypass that bridge. No model self-approval,
expert outreach or synthetic data completion is claimed. Expert drafts remain
unsent. Jobs without tasks use canonical intake/reference and retain unassessed
factual semantics. Later parent pack factories similarly require a complete
manifest/inventory/report bridge; this driver still rejects appended scope.

Pending execution currently exits the Workflow as `on_hold`; an authenticated operator or approved scheduler must resume the original canonical job with the same operation identities after checking the retained provider/checkpoint state. There is no timed lease expiry, blind replay, replacement branch, or automatic completion. Concurrent invocation and crash after external dispatch may require manual reconciliation. The existing app `withBudget` outer reservation is retained on thrown ambiguous work; core task/budget ledgers remain authoritative for agent calls. Deployment must verify aggregate reservations, final costs and Gateway/target accounting before real spend.

Apply all separate migrations through the owner's migration process. Supply admitted canonical target revision/calendar review binding and simulator branch schema. Deploying this patch does not provision those resources. Required acceptance still includes real authenticated Workflow dispatch, private artifact download across users, native PostgreSQL restart/multi-process checks, provider usage reconciliation, budgets, and paid-scope configuration. No cloud/provider/live call, spend, secret retrieval, outreach, push, PR or deployment was performed.

The parent independent verification runner executes the actual patched inventory/artifact source against PGlite and actual rich step source with explicit offline service fixtures. Behavior fixtures establish orchestration decisions, not cloud/provider authentication or monetary truth. See parent validation output for exact final counts and typecheck scope.
