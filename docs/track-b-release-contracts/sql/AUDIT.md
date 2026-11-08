# Track B SQL release audit

Source baseline: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`. Read-only Track A reference: `8634ceb30f3d98de7ec24b240a4f7549dce80033`. No remote lookup. All nine tracked `.sql` files are inventoried below; the runner rejects additions/deletions so new artifacts require audit. Track A's 15 application migrations are read from that immutable commit, executed in filename order, and never copied into or modified in the checkout. No manifest changes. A tracked-source search for CREATE TABLE/SCHEMA/TYPE and ALTER TABLE in `.ts`, `.mjs`, `.md` and `.patch` found only test fixture DDL outside these SQL files; no additional embedded deployment migration was found. The data `verify-native.mjs` is an opt-in verifier, not another migration, and was read but not run. Track A migration metadata is not a separate migration stream.

| Artifact | Destination / order | Replay / transaction assumptions |
| --- | --- | --- |
| `packages/core/src/agents/persistence-migrations/001-agent-persistence.sql` | Application; independent `agent_persistence` schema | Once only; schema creation rejects replay. Runner must wrap transaction. |
| `packages/core/src/evals/data/persistence-migrations/001-evaluation-data.sql` | Application; independent `evaluation_data_persistence` schema | IF NOT EXISTS; runner wraps transaction; no shape validation of preexisting table. |
| `packages/core/src/evals/integration/migrations/001-text-integration.sql` | Application; independent `text_integration` schema | IF NOT EXISTS; runner wraps transaction; no shape validation of preexisting table. |
| `packages/core/src/reporting/chat/persistence-migrations/001-conversations.sql` | Application; scopes before exchanges (FK) | Once only; caller transaction required; conflicts with documentation copy. |
| `packages/core/src/simulator/ledger-migrations/001_branch_ownership.sql` | Application ONLY; never simulator seed | Once only; caller transaction required. |
| `packages/core/src/simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql` | Application ONLY | IF NOT EXISTS; caller transaction required. |
| `packages/core/src/simulator/migrations/001_calendar.sql` | Simulator seed ONLY; runs before calendars before dependent rows | IF NOT EXISTS; caller transaction required; do not fold into application migration batch. |
| `docs/progress-chat-integration/server/001-private-conversations.sql` | Alternative application chat artifact | Contains BEGIN/COMMIT; identical chat DDL, conflicts with core copy; commits caller transaction. |
| `docs/structured-progress-integration/backend/001-structured-progress.sql` | Application; independent `structured_progress` schema | IF NOT EXISTS; caller transaction required; revokes PUBLIC schema/table permissions. |

All files use `001` independently. A global migration registry must key by full path/component, not numeric prefix or basename. There is no repository-wide Track B SQL runner defining that choice. No cross-component foreign keys impose application ordering; the checks execute the seven canonical application artifacts forward and reversed after all 15 Track A migrations and compare catalogs. Track A columns remain unchanged. Internal calendar and chat FK order is required and tested as supplied. These checks establish schema coexistence; they do not establish app/workflow producer wiring.

## Reproduced release conditions (outside assigned ownership; no fixes)

1. **Duplicate chat migration**: execute core chat SQL, then documentation chat SQL (or reverse): PostgreSQL `42P07`, relation `reporting_chat_scopes` already exists. A deployment must select exactly one artifact. The documentation copy is an alternative, not the next migration. Both individually execute successfully.
2. **Nested transaction escape**: `BEGIN; <documentation chat artifact>; ROLLBACK; SELECT to_regclass('reporting_chat_scopes');` returns the table. Its internal COMMIT committed the outer transaction. Choose core SQL under a transaction-owning runner, or run the documentation copy only as its own top-level transaction. Do not treat successful defect reproduction as acceptance of an atomic combined batch.
3. **Existing schema drift**: `CREATE SCHEMA text_integration; CREATE TABLE text_integration.checkpoints(bogus text); <text migration>; SELECT job_id FROM text_integration.checkpoints;` ends with `42703`. IF NOT EXISTS does not validate/repair old tables. Deployment must verify existing catalog or use a known pristine schema. Same assumption applies to other IF NOT EXISTS artifacts.
4. **Session search path**: `CREATE SCHEMA alternate; SET search_path=alternate,public; <core chat SQL>; SET search_path=public; SELECT to_regclass('reporting_chat_scopes');` returns null; alternate table exists. Chat, branch ledger, workflow journal and simulator tables are unqualified in DDL/runtime. Migration role and runtime role need the same trusted explicit search_path, without untrusted writable schemas. Runtime code does not uniformly set it. Qualified agent/data/text/inventory schemas avoid table lookup ambiguity but still need role privileges.

These are reproducible deployment hazards/conditions, not a claim that Track A currently applies both chat copies or uses an unsafe search_path. Strict mode deliberately fails until an owner supplies a concrete safe deployment selection/session/schema contract. It does not convert expected failures into release approval.

## Runtime transaction/session contract audit

- `agents/postgres-ports.ts`, `evals/data/postgres-store.ts`, `evals/integration/checkpoints.ts`, and `reporting/chat/postgres-conversations.ts` require a pinned connection, READ COMMITTED, commit only on success, rollback on error and no callback retry. They lock rows and then read in a subsequent statement. Independent pool.query calls and HTTP SQL calls do not meet this contract. External provider actions must stay outside retryable SQL callbacks.
- `simulator/postgres.ts` needs pinned BEGIN/COMMIT/ROLLBACK. Calendar mutation locks the run row; seed/restore and FK cascades are transactional. Single-session checks cover constraints/rollback, not competing writers.
- `simulator/branch-ledger.ts` and `simulator/workflow/postgres-journal.ts` require session-mode/direct pools and session advisory locks held on one connection, saves autocommitted before external dispatch, unlock before release, destroy connection on cleanup uncertainty. Wrapping the whole callback in a transaction violates durability-before-dispatch. Transaction pooling/HTTP SQL is unsuitable. PGlite does not prove these locks; this suite does not stub them to claim acceptance.
- `docs/progress-chat-integration/server/files/apps/web/src/server/progress-chat.ts` pins READ COMMITTED writes and REPEATABLE READ READ ONLY projection reads, with local statement/lock timeouts, rollback and release. It does not pin search_path.
- Structured progress projection requires an authorized pinned REPEATABLE READ READ ONLY transaction; its inventory producer requires a pinned write transaction, locks, and consistent revision/watermark updates. The inventory migration alone cannot provide producer completeness. Its job primary key assumes globally unique application job IDs; no cross-table tenant FK or RLS is added by these artifacts.
- Schemas/JSON checks provide partial structural defense; rich record validation and authorization belong to adapters and trusted private server roles. No audit claim that direct arbitrary SQL writes enforce every domain invariant. Chat tables grant no PUBLIC privileges by default; deployment role grants remain the owner's responsibility.

## Offline entrypoints

From any directory within this checkout:

```
node "$(git rev-parse --show-toplevel)/tests/track-b/release-contracts/sql/run.mjs" --strict
node "$(git rev-parse --show-toplevel)/tests/track-b/release-contracts/sql/run.mjs" --characterize
node "$(git rev-parse --show-toplevel)/tests/track-b/release-contracts/sql/run.mjs" --acceptance
```

`--strict` is the combined scoped integration entrypoint: runs positive checks and defect characterizations, exits 1 for the four unresolved deployment conditions. `--characterize` runs the same assertions but exits 0 when all expected behaviors reproduce; it is explicitly not release acceptance. `--acceptance` runs only the positive pristine-schema/canonical-selection checks; it is not a complete release gate. Any unexpected assertion failure exits nonzero in every mode. No broad fixture suites, skips, installs, provider calls, secrets, supplied DB URLs or persistent database writes.

Dependency lookup: explicit `TRACK_B_SQL_NODE_MODULES`, then `tests/track-b/node_modules`, then known existing offline `/tmp/autonomous-evals-checks.m10du4/node_modules`. Set the override to an existing node_modules directory on another machine. Repo resolves from cwd through git; artifacts are read directly from that checkout. PGlite databases are memory-only and closed after each check. Syntax check: `node --check tests/track-b/release-contracts/sql/run.mjs`.

Limitations: single-session PGlite is PostgreSQL WASM, not native independent backends, Neon failover, production ACL/RLS, lock contention, deadlocks or session-pool acceptance. No application/provider/runtime deployment acceptance; no execution of other teams' broad tests. All edits/commit are limited to the two assigned SQL directories. Execution transcript is in `RESULTS.txt`.
