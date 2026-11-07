# PostgreSQL private chat persistence

`createPostgresConversationPort` implements the authoritative `ConversationPort` without changing the service, file adapter, Track A schema or public contracts. Import directly from `packages/core/src/reporting/chat/postgres-conversations.ts` (use `.js` in compiled ESM imports); it is deliberately not added to the existing barrel.

```ts
import { createProgressChatService } from './reporting/chat/index.js';
import { createPostgresConversationPort } from './reporting/chat/postgres-conversations.js';
import { pooledCalendarDatabase } from './simulator/pool.js';

const conversations = createPostgresConversationPort(pooledCalendarDatabase(serverPool));
// Construct per authenticated request, using trusted server adapters:
const service = createProgressChatService({ access, progress, conversations });
```

The structural `ConversationTransactionalSql` interface is compatible with `AgentTransactionalSql`. Supply a server-side pg-compatible pool using **READ COMMITTED** and a pinned connection for the full transaction. The transaction wrapper must roll back on callback errors, propagate failed commits, release/discard failed connections and never retry callbacks automatically. Independent `pool.query` calls and Neon HTTP queries cannot implement this transaction interface. Configure pool acquisition, statement and lock timeouts for the deployment. Higher isolation can produce serialization errors; these fail closed and the caller may retry the same message ID.

Apply `packages/core/src/reporting/chat/persistence-migrations/001-conversations.sql` once through the application's migration runner **in a transaction**, before enabling the adapter. This optional artifact is not registered with, or applied to, any application or cloud database here. It creates only `reporting_chat_scopes` and `reporting_chat_exchanges`, using PostgreSQL `text`, `bigint` and `jsonb`. The migration intentionally fails on preexisting table names so an incompatible schema cannot silently pass. Deploy with a controlled search path and migration ownership; the server role needs SELECT/INSERT/UPDATE on scopes and SELECT/INSERT on exchanges. Keep tables private to trusted server code. No public/browser table grants are provided.

Every operation binds both authenticated subject and authorized job as SQL parameters. The composite message primary key implements per-viewer, per-job first-write identity; the composite sequence unique index supports bounded, ascending keyset pages (1–50 entries, exclusive cursor). Appends create and lock the scope allocator row, then read the existing message in a separate statement after acquiring that lock. The first committed exchange wins, including its original digest, reply and sequence, even if another candidate has different input. The service turns that differing digest into its existing `conflict` response. Replays never advance the allocator. Allocation and insertion commit together, and failure rolls both back. Scopes serialize independently without application memory locks or a process-local sequence counter. Sequences are bounded by JavaScript's maximum safe integer; exhaustion preserves replay but rejects a new append. Do not delete/reset allocator rows or edit exchange sequences.

All inputs and persisted exchanges are validated against the authoritative schemas. Returned rows are checked against scope and requested message ID; list checks bounds, strict ordering and duplicate IDs. PostgreSQL bigint strings are checked before conversion. Returned JSON is parsed into detached records. Driver, schema, validation, corrupt-row and transaction failures all expose only the fixed `ChatError('storage_error')` message, without causes or database text. SQL identifiers are static and all values are bound parameters. No raw questions are stored; rows hold only normalized-input digest and the validated customer-safe reply.

The adapter is a persistence boundary, not an authorization service. Keep the service's authentication/authorization before every replay/history request. Track A still owns route wiring, safe progress projection, stable evidence IDs, owner/job foreign keys, access policy and retention. The artifact includes only an internal composite foreign key to its allocator; it assumes no Track A identity/job table shape. Any application foreign keys or RLS need a separate Track A migration and tests. Retain replay keys for the advertised idempotency lifetime; deleting exchanges permits message IDs to be reused. Back up both tables together, and plan retention and erasure together with authorization and evidence retention. An ambiguous commit can be resolved by retrying the same scoped message ID after reconnecting.

## Verification

Run the reporting component with the existing nested harness:

```sh
npm --prefix tests/track-b run check -- --components reporting --track-a-ref origin/track-a
```

The adapter tests execute actual SQL and the migration in PGlite, including file-backed restart durability. PGlite uses a single session and is not evidence of independent-session PostgreSQL locking. Additional race tests register only when `CHAT_PERSISTENCE_TEST_DATABASE_URL` points to an explicitly disposable local PostgreSQL database; they never connect to cloud hosts. The live suite owns and removes only its chat tables. Use a fresh database with no application data. Test evidence from this implementation run is recorded below.

Implementation verification (2026-11-07): strict TypeScript plus the requested reporting harness passed **41/41 tests across 5 files**, zero skips. With `CHAT_PERSISTENCE_TEST_DATABASE_URL` set for a newly initialized, loopback-only disposable native PostgreSQL **18.6** server, the same command passed **44/44 tests**, zero skips (15 in the new adapter test file). The final run resolved `origin/track-a` to `bb27ee50dc3adfbeaa0de45b25e337ff16e20de7`, contract digest `b371bb666d7cb623b4db7e59cb2ad43fe15679acecd844d14d5d0d1ceaeb8fc2`. The local server used `fsync`, `synchronous_commit` and `full_page_writes` enabled and was stopped and removed after testing. The existing `tests/track-b/postgres-live` disposable native-server technique was reused through a temporary runner outside the repository; no dependency/manifests or harness changes were needed.

The live cases used distinct backend PIDs and 24 same-ID candidates with different digests/replies; all returned the same original. Twenty-four distinct-ID writers racing an injected post-insert failure produced sequences 1–24 with no missing/duplicate committed sequence. A deterministic holder/waiter case observed `pg_stat_activity.wait_event_type = 'Lock'`, verified the uncommitted row was invisible, rolled the holder back, then verified the waiter obtained sequence 1. Service integration verified replay skips progress reads and conflicting input retains the original digest. The tests additionally cover scope isolation, detached replies, persisted corruption, fixed errors, bounded pages and allocator exhaustion.

Limits: restart durability was tested by closing/reopening file-backed PGlite, not by restarting the native PostgreSQL process. Native tests establish independent-session lock/rollback behavior on a local server, not managed Neon failover, network loss/ambiguous commit, production auth/routes/RLS, or production retention. No cloud migration, provider call or spend occurred. Application rollout still requires migration review/deployment and the trusted access/progress adapters described above.
