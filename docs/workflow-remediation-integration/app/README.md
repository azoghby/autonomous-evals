# App remediation patch

`003-remediation.patch` appends to the pinned workflow patch series plus the
current Track B core overlay described by the parent `SERIES.json`. It adds app
source and an optional migration artifact; nothing is applied to the real app.
Regenerate with `node docs/workflow-remediation-integration/app/build-patch.mjs`.

The internal rich Workflow resolves the saved canonical frozen suite, full baseline
run, target-version identity, confirmed investigation finding and objective failed
check IDs. A request finding ID is only a lookup key. One deterministic confirmed
objective finding is selected per job. The core engineer proposes a replacement
prompt; the actual secured stateless target serializes the replacement into each
of twelve bounded requests. The original suite, scenarios and checks remain the
criteria. Complete detailed verification, executions and applied configuration
receipts enter the private rich evidence artifact. The core checkpoints retain
individual results even when later reporting cannot complete.

Authenticated operator workflow-binding admission optionally accepts
`remediation: { isolation: "request_messages_only", operationMicroUsd: <integer> }`.
This explicitly declares the endpoint's stateless request isolation and a bounded
per-operation budget hold; the amount is **not a provider price**. Missing admission
produces an unverified proposal. Shared job and engineer-period caps use the same
`PRICE_TABLE`, `ROLE_DEFINITIONS`, `NAIVE_BUDGET_PERIOD_ID` and PostgreSQL budget
ledger as agent sessions. Configuration or target-version changes refuse replay.
The PostgreSQL bigint policy value is validated and normalized before use.

Target accounting callbacks are bound explicitly, persist a dispatch fence before
transport and retain observed/late usage. Unknown dollars stay unknown, reservations
stay held and outbox work stays pending. The core `reconcile` API accepts only
owner-authorized authoritative settlement evidence. No public amount-ingest route,
provider billing fetcher or automatic hosted worker is added. The owner must wire
its authenticated reconciliation process to that API and retained receipt IDs.

Priced reconciliation uses `workflow_integration.cost_keys`, the same atomic global
key protocol as session costs, plus a distinct `provider_costs` table. HTTP target
charges never masquerade as Naive or Gateway charges. Reports retain the monetary
completeness limitation because their existing cost inventory does not yet include
this provider table. The optional app/core migration artifacts require owner review
and deployment; runtime performs no DDL.

Rubric checks remain unassessed without an authorized reserved judge. Tool/schema,
guardrail and other proposals are never executed. Trace-only jobs are refused by
this text adapter and retain the core's unverified behavior. Calendar remediation
is not added. The existing appended-pack gate remains mandatory; frozen12 repair
proves no appended-pack success. Receipts establish local serialized configuration,
not remote internal behavior or remote attestation.

`tests/app-remediation.test.ts` composes the real core factory, target, PostgreSQL
checkpoints and durable accounting with PGlite. A transport spy returns deterministic
offline completions without network calls. It checks all twelve actual payloads and
receipts, frozen baseline retention, replay without dispatch, unknown monetary
usage/outbox, unsupported isolation/tool-schema/Trace scope, changed target/finding
refusal, and atomic global cost-key conflicts. It emits full explicitly labeled
offline baseline/trial/receipt/accounting evidence to the staged verification tree.
