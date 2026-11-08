# Track A bootstrap handoff

Latest read-only inspection: `origin/track-a` at
`f28b7a63ec78bbacd5ab7633ccf818a119c99401` (2026-11-07).
Track A has replaced the earlier loader mismatch with lazy server composition in
`packages/core/src/integration/{compose,eval-services}.ts`.
`apps/web/src/server/services.ts` selects it when `EVAL_SERVICES=real`; otherwise
it retains explicitly labeled mocks. Importing the composition performs no I/O.

Real composition now wires Commercial qualification, Trace Audit, report rendering,
target connectivity and branch create/delete/connection resolution. It constructs
SQL task/budget persistence and configured Naïve clients. Text design/run/investigation,
reruns and verified remediation still throw explicit unavailable errors. No deployed
configuration, applied cloud migration or end-to-end acceptance was verified by this
source inspection. Track B's `evals/index` remains a factory entry, not a global instance.

## Concrete app changes required

1. Runtime SDK 0.12.3 and `ipaddr.js` 2.5.0 are now present in Track A's core
   manifest. Its bootstrap uses a WebSocket SQL pool with pinned transactions.
   Configure bounded pool connection/statement/lock timeouts and verify session
   advisory-lock behavior in the deployed connection mode. Track A owns manifests,
   lockfiles and runtime configuration.
2. Apply the separate optional application migrations listed in the persistence
   handoffs. Keep task/budget/checkpoint/journal/chat/data tables in application
   storage, not disposable simulator branches. Apply calendar migration on the
   isolated simulator branch. Configure connection/statement/lock timeouts.
3. The server bootstrap now constructs `AgentSessionService` and `createTrackBServices`.
   Verify authorization at the calling Workflow boundary and atomic cost-key
   deduplication in `ctx.recordCost`. Supply `listJobCosts` for a complete measured
   report ledger (the inspected bootstrap omits it, so report costs remain unknown).
   Preserve trusted internal-fixture identity: the inspected resolver currently
   returns `isFixture: false` for every job.
   Supply `resolveKnownSecrets(ctx)` from authorized server secret storage. It is
   called after `resolveJob` on every invocation, including report replay, and
   must return a detached string list (each secret at least four characters).
   An unavailable policy blocks without provider dispatch. Trace evidence is
   redacted; credential-bearing report inputs/outputs are refused without
   rewriting evidence. Qualification redacts before clipping. Secrets never
   become prompt metadata. Omitting the hook retains generic-pattern screening
   but cannot protect unknown opaque credentials.
4. Target and branch services are composed. Still construct rich text/calendar
   factories with authorized dependency resolvers and map their richer results into
   Workflow. Keep stable operation IDs and complete
   frozen evidence. Do not let request bodies select tenant IDs, branch connections,
   target credential references or arbitrary checkpoint IDs.
5. Preserve `TrackBPendingError`, `TrackBBlockedError`, and branch cleanup-pending
   handling in Workflow. A boolean `RunResult` cannot carry every rich outcome;
   extend the contract or stop on the explicit conversion error. Do not convert
   infrastructure/unassessed outcomes to customer failures to satisfy the signature.
6. Wire private progress chat with authenticated subject/job scope and approved
   progress projections. Persist/export rich report artifacts and retain their
   authorization on downloads. Core exports alone do not enable routes or UI.
   The inspected app still exposes clarification-only `/messages` and a progress
   display; no private progress-chat route/component wiring was found. Evaluation
   data acquisition is likewise not composed into the app Workflow yet.

## Remaining service-shape gaps

The current shared interface additionally requires `proposeAndVerifyFix`.
Track B now supplies `createRemediationServices` through its composition entry point;
see [the remediation contract](track-b-remediation.md) for authenticated evidence,
isolated application receipts, operation reservations and replay requirements.
It can verify prompt replacements against all 12 unchanged frozen text scenarios.
Trace-only and unsupported patches remain unverified. Production wiring and live
acceptance are still outstanding. Track A's deterministic mock template reports
simulated verification and must stay confined to mock jobs.
A proposed prompt change is not evidence that a customer agent is fixed, and
rechecking an unchanged historical transcript cannot prove a patch works.

Rich text/calendar methods accept stable suite/run references and return complete
evidence. They are not drop-in replacements for the old `designSuite/runSuite/
investigate/rerunFinding` signatures. Their documented adapters and storage bindings
must be incorporated deliberately. The factories never silently fall back to mocks.

The next deployment acceptance must exercise an unpaid Trace Audit through the
actual Workflow, authorized persistence, report route and UI before calling the
application's real mode integrated. Provider fixture sessions and isolated SQL
tests do not establish that end-to-end result.
