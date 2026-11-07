# Track B agent persistence

`agents/postgres-ports.ts` implements `AgentTaskStore` and `BudgetLedger` without provider calls, environment reads, or logging. It exports `PostgresAgentTaskStore`, `PostgresBudgetLedger`, and the structural `AgentTransactionalSql` / `AgentSqlExecutor` interfaces. No runtime dependencies were added.

## Parent wiring

The parent must review and install `agents/persistence-migrations/001-agent-persistence.sql` through its application migration process before wiring these ports. This optional SQL artifact has not been applied to cloud databases. It creates the separate `agent_persistence` schema and does not extend or alter Track A tables. It intentionally fails if already installed; migration history belongs to the application. Give the runtime role only schema usage and table SELECT/INSERT/UPDATE privileges, and reserve DDL/deletion for the migration role.

The existing `simulator/pool.ts` adapter is structurally compatible:

```ts
import { pooledCalendarDatabase } from '@ae/core/simulator/pool';
import { PostgresAgentTaskStore, PostgresBudgetLedger } from '@ae/core/agents/postgres-ports';

const db = pooledCalendarDatabase(pool); // pg Pool or compatible Neon WebSocket Pool
const store = new PostgresAgentTaskStore(db);
const ledger = new PostgresBudgetLedger(db);
// Pass store and ledger to the existing AgentSessionService constructor.
```

Use a pinned connection per transaction, READ COMMITTED isolation, rollback on callback failure, and release/discard the connection after completion. A Neon HTTP query function or unrelated pool queries cannot provide this transaction contract. Do not automatically rerun callbacks after ambiguous COMMIT failures: rerun the caller's idempotent operation instead. Existing pool adapter errors have calendar-specific names but need no changes for compatibility. Dependency injection does not own or close the pool. Parent must expose the source subpath through its package exports if necessary; no shared manifests were changed here.

## Semantics

Tasks are JSONB snapshots with a separately indexed bigint revision. Insert starts at revision zero and returns the existing snapshot on replay. A replay with changed task/job/role/purpose/attempt/agent/request/idempotency key/reservation/budget identity throws a fixed conflict code. `createdAt` is first-writer-wins on insert (workers may race with different clocks), immutable thereafter. CAS permits only execution fields, takes the row lock, validates the merged snapshot, and updates with the expected revision predicate. Stale CAS returns null. Reads reconstruct revision from the authoritative column. No delete API is exposed.

Reservation identity includes job, amount, and the sorted set of scope keys **and caps**. Requests require the matching `job:<jobId>` scope and at least one recognized `agent:<role>:<period>` scope; periods use letters, digits, underscore, or hyphen. Duplicate scopes and empty scope lists are rejected. Scope caps are immutable on first use: pass consistent application configuration. Changing a cap requires a separately reviewed administrative process, not a reservation replay.

Each transaction first inserts/locks its reservation ID, then creates/locks scopes sequentially in sorted key order. All scope locks are taken before checking availability. SUM uses PostgreSQL numeric arithmetic and BigInt comparisons, avoiding JavaScript precision loss even when several safe-integer settlements total more than MAX_SAFE_INTEGER. Accepted reservations and measured settlement both count against every scope. Settlement locks the reservation, then its scopes in the same order, replaces the reservation with the full measured amount, and returns the first settlement on replay. Overage can push committed spend above a cap; subsequent availability is zero. Unknown or refused reservations cannot settle.

The first reservation result, including a refusal, is durable. This follows the interface's first-result idempotency promise; it intentionally differs from the in-memory implementation's retryable refusals. Retrying a refused ID returns that refusal even after other reservations release capacity. A changed request under the same ID fails rather than silently authorizing different work. Scope cap conflicts roll back the entire transaction, including newly inserted reservation/scope rows. Failed database operations never produce a partial accepted reservation.

Inputs use bound SQL parameters and fixed schema/table names. PostgreSQL-invalid strings (NUL or lone UTF-16 surrogates, including JSON keys) and lossy JSON values are rejected. Money, revisions, counters, versions, and token counts must be safe integers; money is nonnegative, and reservation/task budgets are positive. Fixed adapter errors never embed request bodies, credentials, IDs, or database exception text. SQL port implementations and application telemetry must also avoid logging bind values or raw driver errors. Tasks must already be redacted by the session service; this adapter does not infer secrets.

## Validation

The nested harness runs strict TypeScript checks and executes the persistence tests with PGlite, a real PostgreSQL SQL engine inside one process. These checks verify SQL syntax and persistence behavior, but do not establish multi-session concurrency. The test file additionally registers real PostgreSQL races when `AGENT_PERSISTENCE_TEST_DATABASE_URL` points at a disposable loopback database. That suite uses pg Pool connections and installs/removes only its own schema; it must never target an existing application database. No live provider or monetary spend is involved.

Run the full harness with `npm --prefix tests/track-b run check -- --track-a-ref origin/track-a`. Install its locked dependencies first with `npm ci --prefix tests/track-b --workspaces=false` if needed. Real PostgreSQL execution is separate evidence from single-connection PGlite tests; see the implementation handoff for the actual run results.

Verified on 2026-11-07 against `origin/track-a` commit `0cf10806c88801b37e2a533132113cb80afc0d7b`: full nested harness passed strict TypeScript and 347 tests, zero skipped. This included 11 PGlite persistence tests and four native independent-session PostgreSQL race tests. The native server was installed in a temporary directory using `embedded-postgres@18.6.0-beta.19` and `@embedded-postgres/darwin-arm64@18.6.0-beta.19`, following the existing Track B postgres-live runner technique from commit `107b2c3`. It used a random loopback port, generated ephemeral password, and a dedicated empty database; credentials and bind parameters were not printed. The harness received only the explicit local test URL. The server was stopped and its database directory removed afterward.

The real races covered 20 requests sharing a role cap across different jobs, 20 requests sharing a job cap across different role periods, 12 simultaneous same-ID task insert/CAS/reserve/settle operations, and a settlement competing with a reversed-scope reservation. Tests observed distinct PostgreSQL backend PIDs. This establishes actual database contention, not simulated row locks. The settlement/reserve race accepts either valid transaction ordering; it does not assert a particular scheduler outcome. The PGlite suite separately verifies exact SQL aggregation above the JavaScript safe-integer total, transaction rollback after writes, SQL-looking bound identifiers, input rejection, immutable identities/caps, stable refusals, detached task snapshots, and restart through fresh adapter instances.
