# Track B integration status

Checkpoint reviewed: `c06a526` (2026-11-07). Track A application, platform,
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
2. Apply the completed package declaration/lock and canonical migration preflight
   artifacts (`docs/release-packaging-integration`). Parent pin/integrity checks
   passed; final combined application validation remains required.
   Actual deployment requires the application owner's migration/configuration
   procedure. Offline migration tests are not proof of a deployed schema.
3. Apply the consolidated corrected chat series (`docs/chat-workflow-release`)
   with Workflow and test real authentication,
   revocation, private storage and evaluation progress. Styled synthetic-API
   desktop/mobile checks do not establish those real service boundaries.
4. Deploy the prepared controlled Text target patch
   (`docs/controlled-acceptance-targets`) and configure Gateway, then run bounded provider and
   application acceptance: identical criteria on buggy/fixed targets, durable
   restart without duplicate dispatch/cost, persisted reports and isolated chat.
   The prepared target is a deterministic fixture, not customer-model validation;
   Calendar requires the separate documented application driver.
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

The earlier pack combined runs retained SQL setup timeouts (90/91 and 89/91).
The parent rerun at `c06a526` passed strict TypeScript and all 91 tests across
six files against Track A `da92bedd`, without changing assertions or timeouts.
Raw output is in `tests/track-b/release-evidence/pack-c06a526.txt`.
Native PostgreSQL checks elsewhere cover specific locking/restart cases, not
universal hosted failover or authorization.

Live evidence already retained: four exact Naïve role configurations were verified
read-only, and one 12-scenario Text design/review completed for 129,924 micro-USD.
That establishes neither live target/Gateway execution nor the deployed product.

Local Track A `da92bedd68b230188e2499fdd8440ea23b2f1d6b` changes lite-engine/runtime
behavior relative to `f0068733ca49c37f40fd7de279325f21a4b5fbbb`; shared contracts are
unchanged. Patch artifact validation remains scoped to its recorded exact pins.

## Integration artifacts delivered after the broad core check

- Approved-data suite admission and stable Calendar operation identity are in core
  at `e61ad97`; strict eval/simulator validation passed 636 tests across 40 files.
- Data suite bridge and secured remediation/accounting app artifacts are committed;
  their combined app composition is being verified separately.
- Pack execution/private report integration is in `docs/workflow-pack-integration`.
  Its delivery reports 54 tests, full core/app types and Workflow compilation;
  that is not evidence that it composes with every later patch.
- Corrected chat/Workflow artifacts report 13 UI, 49 transport, seven server and
  seven anonymous route checks, plus full app types/build. The final benchmark
  guard was separately typechecked/tested after that build. Real sessions remain
  unverified.
- Controlled Text route artifacts report 15 route and 20 existing runner tests.
  No hosted URL is available or claimed. Secrets are not part of these artifacts.

Original pinned evidence is retained unchanged. Application-owner patches still
need one combined source/build check, authorized migrations/configuration and
real deployed acceptance before release sign-off.

## Parent runtime recheck at 4948c74

The full four-group Naïve assurance runner passed strict TypeScript and 54 tests
with existing dependency roots `tests/track-b/node_modules` and
`/tmp/trackb-int/node_modules`. The default root lacked the tsx loader, so its
initial execution failed before tests; the runner now reports that prerequisite
before typechecking. No dependency was installed. Evidence:
`tests/track-b/release-evidence/naive-4948c74.txt`.

This includes three deliberate boundary characterizations: over-cap settled usage,
invalid usage held for reconciliation, and a permissive application cost sink.
The latter remains an application integration obligation; 54 passes do not prove
the deployed sink. The reservation group exercised native local PostgreSQL.

The current-secret rotation check also passed strict types and all five tests
(`tests/track-b/release-evidence/rotation-4948c74.txt`). Its ROT-1 title/comments
now correctly describe its refusal assertions as a regression; the assertions
and production behavior were not changed.
