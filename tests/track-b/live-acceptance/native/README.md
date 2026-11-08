# Local native acceptance

Run from the repository root with an already-installed Track B harness:

```sh
node tests/track-b/live-acceptance/native/run.mjs \
  --harness /tmp/autonomous-evals-checks.m10du4 \
  --track-a-ref f0068733ca49c37f40fd7de279325f21a4b5fbbb
```

The harness path is nonsecret and machine-specific. It must provide the dependencies in `tests/track-b/package.json`. The exact Track A commit must already exist locally; this runner never fetches. Production sources and pinned contract blobs are staged in a disposable directory. Source hashes are recorded; TypeScript transpilation is not a type-check claim.

This command installs pinned `embedded-postgres@18.6.0-beta.19`, its matching native platform package, `pg@8.16.3`, and `typescript@5.9.3` into that disposable directory (npm install timeout 120 seconds). It runs an ordinary-user PostgreSQL process listening only on 127.0.0.1, enables fsync/synchronous_commit/full_page_writes, creates two disposable databases, and performs three clean server restarts. The password is randomly generated, retained only in memory/private disposable runtime state, and omitted from evidence. Captured failure diagnostics redact the private database URL and password. Child test processes receive only PATH/HOME/TMPDIR/SystemRoot plus that generated local database reference; provider configuration is not inherited.

The command reuses existing `postgres-live/verify.mjs` (8 real concurrency/termination/rollback/restart checks), `postgres-live/checkpoints.mjs` (4 ownership/ambiguity/restart checks), and adds 5 native recovery checks in `verify-recovery.mjs`. Query/connection deadlines are 8/5 seconds; lock observation deadlines are 5 seconds. Intentional backend termination is checked explicitly and never retried.

It then reuses these exact source test files with a 180-second subprocess timeout and one worker:

- `targets/tls.test.ts`: real local HTTPS/TLS sockets; only routing and test trust root are substituted. Production Host, SNI, pinned-public-IP options, certificate validation, redirects, encoding, limits, and deadline behavior are asserted. This does not prove public-network TLS deployment.
- `reporting/chat/postgres-conversations.test.ts`: original PGlite cases plus all three opt-in independent-native-session cases, in a separate fresh database so the test applies its actual migration.
- `evals/text/__tests__/live-v3.test.ts`: 16 **offline** checks against the already accepted twelve-scenario design artifact/digest and recorded 129924 microUSD. No new design request or paid session.
- `targets/remediation.test.ts` and `evals/remediation/remediation.test.ts`: existing **offline** secure target receipt, ambiguity, accounting, and isolated-remediation service enforcement cases. Injected target/agent ports do not establish provider correctness.

A zero process exit is insufficient: every selected file must contain tests and every assertion must have status `passed`. Skipped/todo/missing cases fail the run. The final success line explicitly states external-provider acceptance was not run. Server shutdown and disposable-directory removal are checked in the final cleanup line.

`results.txt` records the final run. `initial-staging-failure.txt` retains an earlier failed harness integration attempt: native 17 checks passed, but two remediation test files could not import unstaged contracts and the native-chat test collided with recovery tables. The runner corrected these staging issues by requiring the pinned contract ref and creating a separate chat database; no production source or test assertion was changed.

Expected application interfaces: `SqlPool` must provide pinned session connections; `pooledCalendarDatabase` must pin transactions and never retry callbacks; `PostgresWorkflowInvestigationJournal` must commit each intent before dispatch, preserve tenant/key identity and immutable completed evidence, and retain ambiguous intent across restart; `ConversationPort` must bind both authenticated subject and authorized job for every operation and replay the immutable first exchange. The local checks test these current core adapters directly. The app workflow team owns route/auth/deployment integration; that real app/provider acceptance remains a separate gate.
