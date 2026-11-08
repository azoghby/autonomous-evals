# Canonical migration manifest and offline preflight

This package selects **only the core conversation migration**. It does not apply
SQL to a service, edit application owner files, or duplicate migration/patch
contents. [manifest.json](manifest.json) references and SHA-256 pins the existing
artifacts. The Workflow bootstrap SQL is extracted from its existing new-file
patch hunk; the patch is never applied by this package. A changed source refuses
verification until its manifest and review are deliberately updated.

The preflight runner is
[verify.sh](../../../tests/track-b/release-packaging/migrations/verify.sh), backed by
[preflight.mjs](../../../tests/track-b/release-packaging/migrations/preflight.mjs).
It opens only disposable in-memory PGlite databases from an existing local cache.
There is no DATABASE_URL input, download/install fallback, network/provider client,
cloud migration, or production apply command. The exported `plan` accepts a pinned
SQL adapter for owner integration; `executeDisposable` is explicitly a test helper,
not an application migration registry.

## Owner deployment order and transaction ownership

First integrate compatible application/core sources and review the existing chat,
structured-progress, Workflow and data-intake patch layers. This manifest is a SQL
contract, not a resolution of application patch conflicts. Its exact local owner
baseline is Track A `f0068733ca49c37f40fd7de279325f21a4b5fbbb`, containing 15
application migrations. A different final owner schema requires a fresh explicit
catalog review and reference; it is not automatically accepted.

| Order | Artifact ID | Transaction owner | Owner prerequisites |
| --- | --- | --- | --- |
| 0 | applicationBaseline (15 full paths in manifest) | Existing owner migration process | Apply existing app schema first; do not replay these through the new runner |
| 1 | agent | Runner | Separate `agent_persistence`; existing empty schema refuses |
| 2 | ledger | Runner | Application database only, never seed/per-job branches |
| 3 | data001 | Runner | Evaluation-data acquisition storage |
| 4 | data002 | Runner | After data001; immutable operation ledger/function/trigger |
| 5 | checkpoint | Runner | Before durable Text factory use |
| 6 | chat | Runner | Core artifact only; scopes before exchanges internally |
| 7 | journal | Runner | Application database only |
| 8 | inventory | Runner | Before any trusted expected-inventory publisher |
| 9 | workflow001 | **Artifact** (`BEGIN`/`COMMIT`) | All above, existing jobs/customers/costs, historical cost-key reconciliation |
| 10 | workflow002 | **Artifact** (`BEGIN`/`COMMIT`) | workflow001 schema, before rich artifact producers |
| Separate database | simulatorSeed | Runner | Calendar seed only; never include in application batch |

Each runner-owned artifact gets one `BEGIN`/success `COMMIT`/error `ROLLBACK` on
one connection. Each artifact-owned Workflow migration executes at top level on
an **idle dedicated connection**, with rollback cleanup on failure. Never wrap
Workflow SQL in an outer transaction. The entire series is not one atomic batch;
record each committed artifact in the owner's durable migration registry. Use its
full source path (and patch target for extracted SQL) plus checksum as identity,
never `001`/`002` or basename. This package does not create a parallel registry.

Do not apply `docs/progress-chat-integration/server/001-private-conversations.sql`
as well as the chosen core chat artifact, including via an automatic migration
file glob. The documentation copy includes its own transaction and creates the
same tables. If that alternative was already applied, reuse requires a full exact
catalog comparison and an explicit owner registry reconciliation to the canonical
identity. Do not apply the core DDL again. Exact-compatible once-only tables can
be reused by the preflight; this alone does not prove migration history or cost
backfill provenance. Historical cost data still requires owner reconciliation.

## Compatibility and session contract

`plan(db, expected)` checks the **whole batch before any write**. `expected` must
be generated on a disposable database with the exact baseline and actual SQL,
using the same PostgreSQL engine version, deployment role and pinned path as the
target. The verifier demonstrates this reference construction. It compares all
baseline application tables, then every managed table's relation flags, ordered
columns/types/nullability/defaults/collations/ACLs, exact PostgreSQL CHECK/PK/FK/
UNIQUE definitions and deferrability/validation, index definitions and readiness,
noninternal triggers and full function definitions/configuration/ACLs, policies
and inheritance. It also checks managed schema ACLs. Missing constraints, changed
expressions and disabled immutability triggers refuse even when columns match.
Partial artifact installation refuses. There is no IF NOT EXISTS-based acceptance
or automatic drift repair. Unrelated public tables are not treated as managed
objects. This is conservative catalog equality, not proof against a malicious DB
owner, dependency extension replacement, or every possible PostgreSQL catalog
feature. Final engine/version/extension/default-privilege differences need review.

Before planning or applying, the owner must:

1. Quiesce migration/runtime writers, acquire the owner's database migration lock,
   and use a dedicated idle direct/session connection. Maintain that lock through
   preflight, per-artifact commits, postflight comparison and registry writes.
   Preflight without this lock has a check/write race. No transaction-pooling or
   HTTP statement executor satisfies the session contract.
2. Pin migration **and runtime** `search_path` to `public, pg_catalog`, with no
   temporary objects, and READ COMMITTED for normal writes. The helper `pinSession`
   sets session settings; it does not secure schemas or prove adapter pinning.
   Session checks refuse different paths/isolation, temporary relations and PUBLIC
   CREATE grants on managed schemas. Explicit public-first placement is required
   because unqualified DDL must land in public; runtime lookup must match.
3. Review schema owners and every non-PUBLIC CREATE grant for trust. Revoke CREATE
   from untrusted roles before this check, and deny runtime DDL/TEMP/ownership.
   PUBLIC CREATE denial alone cannot identify all untrusted members/role grants.
   Provision private server-only DML grants; no client/public direct data API.
   Exact owner-named ACLs are intentionally conservative and may require a fresh
   same-role reference rather than normalization that hides privilege drift.
4. Review duplicates in historical `costs.meta.idempotencyKey`. Preflight rejects
   duplicate non-null-job string keys before writes; workflow001's actual insert
   also refuses collision. Missing rows/orphans or unsupported legacy data must
   be reconciled by the owner, never silently discarded. Preserve the single
   Workflow cost identity sink when combining the data-intake patch.
5. Postflight compare the complete catalog and reconcile the durable registry.
   Compatible-existing reuse checks structure, not historical backfill contents,
   application authorization or valid existing data. Migration owners must audit
   these separately before enabling workers.

Runtime agent/data/checkpoint/chat writes need pinned transactions with rollback
on error and no callback retries; providers run outside retryable SQL callbacks.
Branch ledger and Workflow journal need pinned session advisory locks and durable
saves before dispatch, not an outer transaction around dispatch. Structured reads
need authorized REPEATABLE READ READ ONLY snapshots; set these deliberately after
normal session preflight. The verifier does not establish these runtime properties.

## Reproduce and evidence

From the repository root, using only an existing dependency cache:

```sh
node --check tests/track-b/release-packaging/migrations/preflight.mjs
node --check tests/track-b/release-packaging/migrations/verify.mjs
TRACK_B_SQL_NODE_MODULES=/tmp/track-b-harness/node_modules \
  tests/track-b/release-packaging/migrations/verify.sh
```

The shell wrapper acquires `/tmp/track-b-release-heavy.lock` with `mkdir` and traps
cleanup. Exit 75 means busy: no SQL starts; perform light review/syntax checks and
retry later. Never remove another process's lock. Direct verifier invocation is
rejected without the wrapper's lock marker. No scoped heavy process is delegated.

[RESULTS.txt](RESULTS.txt) records actual execution at parent base `f8d1f75`.
The actual 15 baseline SQL files and ten canonical app artifacts build a catalog
of 14 managed tables and 133 constraints. The suite checks repeat-plan idempotency,
actual replay of IF NOT EXISTS SQL, incompatible preexisting tables, missing and
changed CHECKs, partial installs, disabled triggers, session/ACL/temp refusal,
historical cost collisions, immutable operation completion/delete, transaction
rollback and separate simulator-seed FK/index catalogs. The fixture explicitly
revokes PUBLIC CREATE on its public schema; that is synthetic test setup, not a
claim about deployed role configuration. The duplicate-cost fixture temporarily
uses replication mode to construct inconsistent rows only inside disposable SQL.

**Verified facts:** see the successful assertion transcript; source hashes,
actual SQL execution and PostgreSQL-generated definitions supply the evidence.
This is single-session PostgreSQL WASM proof. No native multi-session/concurrency,
production grants/RLS, authentication, external dispatch or deployment was tested.

**Deployment assumptions / blockers:** the owner must integrate the final source
and patch composition, choose its migration registry/lock and trusted roles,
reconcile history/backfills, run native database concurrency and restart tests,
and complete the Workflow/data/chat live acceptance gates. The data/Workflow
handoff still requires shared cost-sink composition and authorized production-data
advance/inventory wiring, as described in their existing reports. This manifest
resolves SQL selection and documents transaction boundaries; it does not resolve
those application/runtime blockers or accept deployment.
