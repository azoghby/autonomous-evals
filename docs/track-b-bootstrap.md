# Track A bootstrap handoff

Inspected `origin/track-a` at `be522f1e13e697017bac96728748b82cadc08ab9`.
`apps/web/src/server/services.ts` defaults to labeled mock services. Its real-mode
loader imports `@ae/core/evals/index` and expects a global `evalServices` instance.
That assumption does not match the authorized dependency-injection boundary.

Track B now supplies that import path as a side-effect-free factory entry point.
It deliberately exports no preconstructed `evalServices`: importing a package
cannot establish caller/job authorization, safe pool mode, configured role IDs,
or atomic budget reservations. Switching `EVAL_SERVICES=real` alone still fails
closed; this is not a production bootstrap or a completed app integration.

## Concrete app changes required

1. Add the runtime packages used by these modules to the appropriate workspace:
   `@usenaive-sdk/managed-agents` (validated at 0.12.3) and `ipaddr.js` (2.5.0).
   The inspected core manifest contains neither. Supply a compatible pinned-session
   PostgreSQL driver/pool for the SQL ports; nested test dependencies do not ship
   with the application. Track A owns manifests and lockfiles.
2. Apply the separate optional application migrations listed in the persistence
   handoffs. Keep task/budget/checkpoint/journal/chat/data tables in application
   storage, not disposable simulator branches. Apply calendar migration on the
   isolated simulator branch. Configure connection/statement/lock timeouts.
3. In a server-only bootstrap module, construct `AgentSessionService` with durable
   task and budget ports, the configured Naïve session client, trusted role IDs,
   budget period and worker identity. Build `createTrackBServices` with authorized
   `resolveJob` and deduplicated measured-cost persistence. This provides the
   Commercial, Trace Audit and existing report operations.
   Supply `resolveKnownSecrets(ctx)` from authorized server secret storage. It is
   called after `resolveJob` on every invocation, including report replay, and
   must return a detached string list (each secret at least four characters).
   An unavailable policy blocks without provider dispatch. Trace evidence is
   redacted; credential-bearing report inputs/outputs are refused without
   rewriting evidence. Qualification redacts before clipping. Secrets never
   become prompt metadata. Omitting the hook retains generic-pattern screening
   but cannot protect unknown opaque credentials.
4. Construct target and branch services, plus rich text/calendar factories using
   authorized dependency resolvers. Keep stable Workflow operation IDs and complete
   frozen evidence. Do not let request bodies select tenant IDs, branch connections,
   target credential references or arbitrary checkpoint IDs.
5. Replace the dynamic global-instance assumption with this explicit composition.
   Preserve `TrackBPendingError`, `TrackBBlockedError`, and branch cleanup-pending
   handling in Workflow. A boolean `RunResult` cannot carry every rich outcome;
   extend the contract or stop on the explicit conversion error. Do not convert
   infrastructure/unassessed outcomes to customer failures to satisfy the signature.
6. Wire private progress chat with authenticated subject/job scope and approved
   progress projections. Persist/export rich report artifacts and retain their
   authorization on downloads. Core exports alone do not enable routes or UI.

## Remaining service-shape gaps

The current shared interface additionally requires `proposeAndVerifyFix`.
Track B has no real verified-remediation implementation. Track A's deterministic
mock template reports simulated verification and must stay confined to mock jobs.
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
