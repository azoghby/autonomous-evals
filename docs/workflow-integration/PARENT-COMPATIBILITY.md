# Read-only compatibility review of later parent deliveries

The series remains pinned to core `5906961c2a70c0d6d2999cf7086689402ff60f5b`.
These later parent commits were read from local Git without fetching or modifying
their sources/artifacts. They are not included in the validation claim for that pin.

## Data production: parent `66da7a4` (original `7db58a0`)

Read `evals/data/postgres-operations.ts`, persistence migration002, the intake
README and full `docs/data-production-integration/intake/track-a.patch`.
The parent already supplies the shared transactional ledger, authenticated human
review and production acquisition/design/freeze composition. Do not reimplement it.

`advanceProductionData(jobId, input)` takes `ProductionDataInput` from an authorized
durable Workflow plan: task, initial candidate batch, versionLabel/systemPrompt,
and optional trusted discovery config. It is a private capability, not an HTTP
review action. Preserve the exact input identity on retries. Only `ready` with
`frozen` admits the returned reviewed suite/provenance. Pending review, cost,
mapping/freeze or reconciliation does not authorize target execution.

Concrete remaining composition work:

1. Apply the parent's migration transactionally through the deployment migration
   process, after integrating its core exports. Its ledger uses the same pinned
   `AgentTransactionalSql` shape as this series.
2. Resolve the duplicate `buildAgentDeps` export edit when combining patches.
   An actual offline `git apply --check` of the parent intake patch on our fully
   assembled archive refused that hunk in `integration/eval-services.ts`; our
   patch already exports and hardens the function. Retain our verified pinned
   directory/stable budget requirements and apply the parent's new files once.
3. Replace the parent's separate job-row-lock cost writer with the single
   `recordCost`/`upsertWorkflowCost` identity protocol from this series. A keyed
   table cannot deduplicate a concurrent writer that bypasses it. Review historical
   entries before applying the keyed migration; conflicting identities abort.
4. Register task inventory before advance, preserve every pending state, and
   store the ready suite plus provenance immutably. Bind that suite into the rich
   service's durable suite lookup instead of calling independent design again.
   This requires an explicit authorized suite-admission adapter; manufacturing
   private checkpoint keys or re-freezing an approved suite is not an integration.
5. Update inventory after task/cost/job writes. The current driver deliberately
   refuses jobs with data tasks until this bridge is supplied. Authenticated review
   HTTP intake never resumes work or grants model approval.

## Live harness: parent `ab83d20` (original `d145905`)

Read `tests/track-b/live-acceptance/provider/app-run.mjs`. Its
`createAcceptanceDriver` contract requires actual app/provider provenance,
`fallback: false`, bounded metered dispatch through `beforeDispatch`, real process
restart, matching frozen Calendar buggy/fixed evidence, actual remediation
dispatch receipts, durable accounting/private reports and private chat access
checks. The driver must return evidence from those actual engine paths; offline
fixtures cannot fill these fields. This series does not implement that driver or
run the harness live. Its remediation/Gateway accounting obligations remain open.

## Packs: parent `5ad4b41` (original `2e8b303`)

Read the complete `docs/track-b-pack-integration.md`. Reuse its exported factories,
reviewed manifest and exact pinned Track A grader. Its accepted IDs are
`rt_inj_direct_fake_system` and `rt_jb_dev_mode`; other semantics remain quarantined,
not silently removed or passed. Preserve all appended IDs with
`draftFromAppendedInventory`, authoritative review/authorization records and
actual target digest. Retain base12 separately and execute under a stable pack
identity with durable checkpoints. Export `service.report` with full base/pack
statuses and propagate them through inventory, reports, comparison and remediation.

The current inventory schema and rich driver do not yet carry pack formats or
source-rule/review/configuration associations. Composing only supported cases would
omit paid scope. The current explicit appended-pack refusal therefore remains.
Release-team review and the missing Workflow/report/inventory bridge are required;
base12 remediation must remain labeled base12 only. No full-pack success is claimed.
