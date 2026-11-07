# Track B live PostgreSQL verification

Independent verification on 2026-11-07 of working-tree production inputs at base commit `4a5915df9d2efcd90a6fe533e011a192fb338b8b`: **8/8 checks passed, zero skipped, no production defect found in the covered scenarios**. Production sources, existing harness, dependency manifests, and Track A were not edited. Full run evidence is in [results.txt](../tests/track-b/postgres-live/results.txt); source and migration SHA-256 hashes identify the exact inputs.

## Runtime and provenance

Real PostgreSQL **18.6**, `aarch64-apple-darwin24.6.0`, Apple clang 17.0.0, 64-bit; Node 24.21.0, node-postgres 8.16.3, TypeScript 5.9.3. The runner installs `embedded-postgres@18.6.0-beta.19` and its exact platform package into a disposable `/tmp` directory. The beta suffix belongs to the wrapper package; the server reports PostgreSQL 18.6. npm verifies registry tarball integrity; recorded SRI values are in the evidence file. This is package integrity verification, not an independent audit of the binary build chain.

The [maintainer's source and documentation](https://github.com/leinelissen/embedded-postgres) describe the platform binaries, supported versions, lifecycle, flags, and symlink rehydration. Their binaries derive from [Zonky's PostgreSQL binary project](https://github.com/zonkyio/embedded-postgres-binaries). The runner explicitly disables OS user creation and enables package-local symlink rehydration. No global service, system configuration, Docker daemon, cloud database, or user credentials are used.

The server binds TCP only to `127.0.0.1` on an OS-selected ephemeral port (59800 in the recorded run), with Unix socket and database files in the disposable directory. The runner asserts `fsync`, `synchronous_commit`, and `full_page_writes` are all `on`. It creates a dedicated `track_b_live` database, applies the actual optional application ledger migration there, and creates a small calendar transaction probe table. This does not apply migrations to a simulator database or any existing application database.

## Reproduction

From the repository root, with Node/npm and network access for the pinned temporary runtime:

```sh
# Use an existing isolated Track B harness with typescript, zod and ipaddr.js.
TRACK_B_HARNESS=/tmp/track-b-harness node tests/track-b/postgres-live/run.mjs
# If the repository harness dependencies are installed, no override is needed:
node tests/track-b/postgres-live/run.mjs
```

Run as an ordinary OS user. Unsupported platform binaries, dependency absence, or runtime installation/startup errors fail the command; nothing silently skips. The default harness is `tests/track-b`. Existing harness dependencies are read, not modified. Current source files are transpiled into an isolated ESM snapshot with the harness TypeScript compiler, preserving actual runtime imports. This runner does not perform a strict type-check or run the existing PGlite suite. It needs no pg dependency in the existing harness because pg is installed alongside the disposable runtime. No repository manifests are created or changed.

The runner uses separate real `pg.Pool` instances (one connection each) for holders and contenders, plus an independent observer pool. The observation wrapper records PID/release status and forwards every query unchanged; advisory lock functions are never mocked. Wait checks require `pg_blocking_pids()` to name the actual holder and `pg_locks` to contain an ungranted lock. A five-second observation deadline and eight-second statement timeout bound contention checks. The brief close/rebind gap in ephemeral-port allocation can cause a startup failure if another process takes the port; the runner never falls back to an existing database.

## Checks and findings

| Check | Live evidence and assertion |
| --- | --- |
| Same-job serialization | Backend 49005 waited on `advisory`, blocked by 49004. The second callback had not entered; an unrelated job completed concurrently. After release, the waiter read the first owner's committed `ready` record. |
| Durable creating intent | An independent session read `creating` while the callback was still active. The callback then threw its original error. A fresh ledger on another pool recovered the identical intent. |
| Backend termination | A real same-job waiter was observed before `pg_terminate_backend(pid,5000)`. The waiter acquired the lock and read `creating` while the original JavaScript callback remained suspended. Resuming that callback caused `branch_ledger_unlock_failed`; the connection was discarded and its replacement had a different PID. |
| Calendar commit and pinning | Statements inside a transaction returned the same PID. An external session saw the previous value until commit; afterward it saw the new value. An escaped executor rejected with `calendar_transaction_closed`. |
| Calendar rollback | Callback failure preserved the original error, rolled back its update, ran the callback exactly once, and left a reusable clean connection with the same PID. |
| Calendar contention | Backend 49010 waited on `transactionid`, blocked by 49008. Both concurrent increments survived after the holder committed. |
| Calendar backend termination | Terminating the backend after an uncommitted update caused transaction failure, connection discard, and no callback retry. The observer saw the prior committed value; the next transaction used a different PID. |
| Server restart | All pools were closed, the PostgreSQL process stopped and restarted using the same disposable data, and a new pool/ledger recovered the intent left by the failed callback. |

Every check additionally requires zero remaining advisory locks. The server was stopped and the complete runner directory (runtime binaries, generated snapshot, database, socket, and temporary package metadata) was removed after the run. The separate bootstrap inspection runtime was also removed. Only owned test/report artifacts were committed.

## Limits

This verifies distinct local backend sessions in one Node process against a direct server. It does not validate transaction-mode proxies, Neon endpoint configuration, cross-process application deployment, cloud POST/DELETE reconciliation, network partitions, ambiguous successful commits, OS crashes, power loss, or WAL crash recovery. Restart coverage is a clean process restart, not a crash recovery claim. Calendar coverage verifies the pool adapter's transaction mechanics using a probe table, not the complete calendar schema/business logic. Transitive npm dependencies are registry-resolved; the wrapper, platform binary, and pg versions are pinned.

Session advisory locks are released when the backend ends, as described by [PostgreSQL's locking documentation](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS); [pg_terminate_backend](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL) with a nonzero timeout waits for termination. The live result confirms the existing ledger documentation's limitation: a surviving callback may still be doing external work after losing its session lock. The durable intent survives, but this lock is not a cloud fencing token. Integration must retain reconciliation/idempotency safeguards already described in `track-b-branch-ledger.md`.
