# Durable workflow investigation journal

`packages/core/src/simulator/workflow/postgres-journal.ts` exports
`PostgresWorkflowInvestigationJournal implements WorkflowInvestigationJournal`.
Its constructor is `(pool: SqlPool, tenantId: string)`. The existing structural
`SqlPool`/`SqlConnection` interfaces accept a node-postgres style pool with
`connect()`, parameterized `query()`, and `release(error?)`. An HTTP SQL function
is insufficient. The trusted application chooses the tenant; it must authorize
job/run access before invoking the workflow.

The parent integration must export/import the adapter and inject it into
`investigateCalendarRun({ suite, run, dependencies, journal })`. This change does
not modify `workflow/index.ts`, application routes, contracts, or pool setup.
The optional migration
`packages/core/src/simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql`
belongs in the durable application database, separate from disposable simulator
branches. It is an artifact only: no existing database or cloud migration has
been applied. Review it through the application's normal migration process.

## Lock and persistence contract

`withLock<T>(key, action): Promise<T>` pins one checked-out connection and takes a
PostgreSQL **session** advisory lock for the tuple `[namespace, tenantId, key]`.
`load(key)` and `save(key, record)` require that adapter's matching active lock;
calling either outside the callback rejects with `workflow_journal_lock_required`.
Nested `withLock` on the same instance rejects rather than deadlocking. Use the
existing workflow's callback pattern. Each operation is queued on that session;
cleanup drains queued operations before unlocking, even if the callback throws
or neglects to await a started operation. Escaped async work cannot use a closed
session. Await every operation, especially the save immediately before dispatch.

Every save runs as its own autocommitted SQL statement. No transaction surrounds
the callback, so a callback failure cannot roll back already recorded intent.
Use a direct PostgreSQL endpoint or a session-mode pool that keeps a physical
backend assigned for the full checkout. Transaction-mode pooling is unsupported.
The pool must destroy connections passed to `release(error)`; failed SQL, failed
lock acquisition, uncertain unlock, and release errors never trigger a retry.
SQL/connect/release exceptions are replaced with fixed `workflow_journal_*`
codes, without driver text, SQL parameters, or connection strings. Callback
errors remain the callback's responsibility and are propagated unchanged.

For PostgreSQL durability, deploy with normal WAL durability settings including
`fsync=on`, `synchronous_commit=on`, and `full_page_writes=on`; the adapter does not
alter server settings. A failed write response can mean the write committed.
Abort dispatch on any failed save. A later explicit investigation may read the
committed intent and will skip it. This adapter never automatically retries SQL
or the callback.

## Identity, budget, and imported data

The primary key is the exact `(tenant_id, journal_key)` pair. Tuple encoding also
prevents delimiter ambiguity in lock names; advisory hash collisions can only
serialize unrelated keys. Arbitrary keys are supported (1–1024 UTF-16 code units)
because the interface owns key construction. If an upstream delimiter-built key
collides, immutable original evidence causes a conflict instead of replacement.
Tenant IDs are 1–128 code units. Keep tenant identity stable across deployments.

Both reads and writes validate a closed record shape, scope/scenario/execution
associations, unique original scenario IDs, outcome enums, nested state,
transcripts and grades. All nested JSON keys and string values reject NUL and
unpaired UTF-16 surrogates; valid supplementary Unicode is accepted. Nonfinite
numbers, cycles, non-JSON objects and excessively deep data reject before SQL.
Undefined object properties are permitted for workflow optional fields and
omitted on serialization. Imported records are untrusted and receive the same
checks. Validation does not re-grade evidence or authenticate an import; only
trusted, authorized code may write the table. The migration's coarse checks
supplement validation, not replace it.

The first save must have zero attempts. Original run evidence is immutable.
Attempts are a prefix of the first three original `product_failure` scenarios,
in original order. Each added attempt must be pending; completion requires a
previously committed intent. Attempts cannot disappear, change scenario identity,
or replace completed evidence. Updates use a record compare-and-swap in SQL in
addition to the advisory lock. A stale concurrent write fails rather than
silently replacing another record. All terminal/completed evidence is retained.

On restart, an intent with no result remains pending. The existing workflow skips
it and reports its scenario ID; it does not repeat ambiguous work. Other eligible
scenarios may still consume their own one-attempt budget. The journal cannot
recover a missing transcript, decide whether the remote target executed, or
reset a reproduction budget. There is no automatic pending-attempt reconciliation
or administrative reset API.

## Lost-session limitation

Advisory locks are not external fencing tokens. If PostgreSQL terminates the
backend or loses the session while the JavaScript callback survives, another
worker can acquire the lock while that callback is still doing external work.
The committed pending intent prevents the normal workflow from redispatching
that scenario. It cannot cancel the original external call or guarantee global
exactly-once external effects. Keep the existing external idempotency and
reconciliation safeguards. A failed subsequent SQL operation/unlock rejects and
discards the connection. A process that performs external work without first
successfully awaiting its intent save violates the contract.

## Verification

The nested Track B harness is the test entry point; it stages only owned source,
uses strict TypeScript checks, excludes Track A application tests, and limits
Vitest to two workers. Dependencies were installed only with
`npm --prefix tests/track-b ci`. Run:

```sh
npm --prefix tests/track-b run check -- --components simulator --track-a-ref origin/track-a
```

`postgres-journal.test.ts` executes real table statements in PGlite, intercepting
only advisory functions (PGlite cannot establish independent lock sessions).
Coverage includes durable intent before actual workflow dispatch, interrupted
completion and pending recovery, original/completed evidence immutability,
budget/transition restrictions, tenant isolation, JSON/import validation,
autocommit completion, pinned-session cleanup, and safe error codes.

An independent disposable native PostgreSQL 18.6 run on macOS arm64 passed **4/4
checks, zero skipped**, with pg 8.16.3 and Node 24.21.0; all three durability
settings above were on. Backend 94974 waited on an advisory lock held by 94973;
a different tenant proceeded concurrently. An observer read committed pending
intent before callback failure, and a fresh adapter recovered it. Terminating
the lock holder let the waiter read that pending intent while the first callback
survived; the first callback rejected with `workflow_journal_unlock_failed` and
its connection was discarded. Pending intent survived a clean server restart.
The temporary server, runtime, runner and database were removed; the local run
log is `/tmp/workflow-journal-live-results.log` (ephemeral evidence, not a tracked
reproduction runner). Adapter SHA-256 at this verification:
`6c6277cce3b8c558fdf1e623b8b22771aae4c356b0cb53b07a9cf2dd5e430e6c`;
migration SHA-256:
`b9699bc9b7f6aa90e244978fabf0bba876891c20a3b3557c3eea432d85b51ea0`.
This verifies separate sessions in one Node process and a clean restart, not
separate OS worker processes, crash/power-loss recovery, transaction proxies,
cloud integration, or exactly-once external effects. No cloud/provider spend.

The default full-harness run also passed strict type checking, but finished with
623/628 passing tests: five 5-second PGlite timeouts (three existing branch-ledger
tests, the existing calendar acceptance test, and the journal's connection/release
test). The journal lifetime test was then changed to an injected connection,
because it exercises no table SQL and needs no PostgreSQL startup. Existing
production/test files were not modified to adjust their timeouts. This full run
is not a green integration result; the simulator-only rerun is reported separately.

Final simulator-only validation passed strict TypeScript checks and **171/171
tests across 10 files**, including all **23 journal tests**, with no skips,
against Track A contracts at `afd473788741e480b1e1bdf7728e451b5d47aaed`.
An intermediate rerun under shared-machine load also timed out in the existing
branch-ledger test and the journal import-validation test. Journal tests now
have a bounded 30-second allowance for PostgreSQL WASM startup; the final run
completed in 15.86 seconds and every existing simulator test also passed. No
existing test timeout or harness configuration was changed.
