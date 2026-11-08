# Track B integration status

Checkpoint reviewed: `f8d1f75` (2026-11-07). Track A application, platform,
contracts and deployment remain owner-managed. This is an incomplete-release
record, not production acceptance.

## Implemented and integrated

- Naïve task/session runtime, exact-version provisioning verification, durable
  reservations/settlement and replayable cost delivery. Recovery now refuses
  mismatched pinned versions and newly sensitive stored prompts; settlement
  conflicts retain the original settled amount and require reconciliation.
- Trace Audit, secure HTTPS target transport, Text and Calendar execution,
  investigation/reproduction, durable checkpoints, reports and remediation core.
- Private conversation persistence and durable evidence projection; mutable
  authorization identities and caller-owned cost snapshots have been fixed.
- Discovery/generation/review orchestration and shared PostgreSQL acquisition and
  operation stores. Independent human review and immutable provenance remain
  required before ready data can be used.
- Reviewed appended-pack manifests and durable execution. Only two pinned literal
  response semantics are supported; other cases remain visible as quarantined.
- Rich comparison/monitoring with frozen evidence and immutable retained-baseline
  digests. Alerts are drafts; no notification delivery is implemented here.

## Work still required

1. Combine the concrete Workflow/chat patch series with approved-data suite
   admission, secured remediation/accounting, and complete pack inventory/report
   propagation. These integration bridges have separate implementation owners.
2. Finish package declaration/lock and canonical migration preflight artifacts.
   Actual deployment requires the application owner's migration/configuration
   procedure. Offline migration tests are not proof of a deployed schema.
3. Apply the corrected chat series with Workflow and test real authentication,
   revocation, private storage and evaluation progress. Styled synthetic-API
   desktop/mobile checks do not establish those real service boundaries.
4. Configure actual target versions and Gateway, then run bounded provider and
   application acceptance: identical criteria on buggy/fixed targets, durable
   restart without duplicate dispatch/cost, persisted reports and isolated chat.
5. Validate the real keyed cost sink, unresolved usage reconciliation, authorized
   review receipts and approved suite freeze. Unknown costs are never zero.
6. Extend unsupported pack semantics only with reviewed execution/grading
   contracts; preserve every selected case and distinguish base12 verification
   from full-pack verification. Complete comparison/monitoring application wiring.

## Evidence interpretation

The broad default Track B check passed strict TypeScript and 1,116 tests across
65 files, none skipped, at `f8d1f75` against Track A `f006873`. This includes
25 explicit known-contract-gap assertions, not 25 closed gaps. It does not include
every separately staged review/pack/app harness. Raw output is retained in
`tests/track-b/release-evidence/core-f8d1f75.txt`.

The integrated security check passed 38 tests after the latest parent and Naïve
fixes. The cross-service check passed 15 tests after report-cost detachment and
Calendar phase-selection fixes. Naïve recovery's scoped delivery reported 59
passing tests. These are local tests with scripted providers and SQL fixtures,
not live application acceptance. Older review logs intentionally characterize
pre-fix defects and must not be presented as current acceptance evidence.

The earlier pack combined runs retained SQL setup timeouts (90/91 and 89/91);
no timeout or assertion was relaxed. A clean combined pack check remains required
under controlled resource load. Native PostgreSQL checks elsewhere cover specific
locking/restart cases, not universal hosted failover or authorization.

Live evidence already retained: four exact Naïve role configurations were verified
read-only, and one 12-scenario Text design/review completed for 129,924 micro-USD.
That establishes neither live target/Gateway execution nor the deployed product.

Local Track A `da92bedd68b230188e2499fdd8440ea23b2f1d6b` changes lite-engine/runtime
behavior relative to `f0068733ca49c37f40fd7de279325f21a4b5fbbb`; shared contracts are
unchanged. Patch artifact validation remains scoped to its recorded exact pins.
