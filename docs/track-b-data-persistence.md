# Track B evaluation-data PostgreSQL persistence

Implemented in `packages/core/src/evals/data/postgres-store.ts`; the existing file store is unchanged. The parent owns the public export and application wiring. No deployment, live database migration, cloud/provider calls, dependency installation, spending, outreach, push or PR was performed.

## Factory and database contract

```ts
export interface PostgresEvaluationDataScope {
  tenantId: string;
  jobId: string;
  knownSecrets?: readonly string[] | (() => readonly string[]);
}
export function createPostgresEvaluationDataStore(
  db: AgentTransactionalSql,
  scope: PostgresEvaluationDataScope,
): EvaluationDataStore;
```

`AgentTransactionalSql` is the existing `agents/postgres-ports.ts` contract. `pooledCalendarDatabase(pool)` is structurally compatible. Transactions must pin one connection, use READ COMMITTED isolation, roll back thrown errors and never retry callbacks. An HTTP query function or independent pool queries do not implement transactions. Factory construction performs no SQL or migrations.

Derive tenant and job from authenticated server authorization, then construct a scoped store. The factory captures those scope strings and rejects a record whose `spec.jobId` differs. All selects, inserts, locked reads and updates bind tenant, job and task through SQL parameters. Tenant/job/task IDs accept 1–96 ASCII letters, digits, underscores or hyphens. Scope filtering is an application boundary; this migration does not implement RLS or replace database role/access controls.

The optional synchronous `knownSecrets` supplier provides the current local safety configuration on every validation, including read/replay and post-write validation. It must only read local policy; do not perform external operations or initiate retries inside it. A static list can instead be supplied to each new instance. The inherited safety screen ignores known-secret entries shorter than four characters and remains a conservative pattern/PII screen, not a complete confidentiality detector.

## Migration

Explicit optional migration: `packages/core/src/evals/data/persistence-migrations/001-evaluation-data.sql`.

It creates `evaluation_data_persistence.tasks(tenant_id text, job_id text, task_id text, revision bigint, record jsonb)` with primary key `(tenant_id, job_id, task_id)`. Revision is bounded to JavaScript safe integers. Checks enforce identifier form, required identity fields, JSON identity/revision agreement and a 1,000,000-byte database JSONB text ceiling. The adapter has a stricter 500,000-byte compact UTF-8 JSON limit, matching the current safety screen's 500,000-character bound. Apply through the authorized deployment migration process before wiring the store. The DDL is rerunnable via `IF NOT EXISTS`; it does not repair an incompatible preexisting table. No live database was migrated.

## Persistence behavior

- `get(taskId)` returns a detached full record or `null` within the bound scope.
- `insertIfAbsent(record)` requires revision zero and uses `INSERT ... ON CONFLICT DO NOTHING RETURNING`, followed by a scoped read of the winner in the same transaction. Concurrent identical requests receive the same winner. A conflicting full spec or requestHash throws `evaluation_data_persistence_identity_conflict`; it never adopts a different request.
- `compareAndSet(taskId, expectedRevision, next)` locks the scoped row, checks the immutable full canonical spec/requestHash, then updates only the expected revision. The proposed revision must be exactly expected + 1. Missing/stale rows return `null`. Existing decision history must remain an unchanged prefix. CAS never reruns the acquisition/provider step.

Every input and returned row undergoes strict nested schema validation, identity/revision validation, current secret screening and lossless JSON validation. Unknown fields, accessors, custom serializers, cycles, sparse arrays, nonfinite numbers, undefined/function/symbol/bigint values, NUL, lone surrogates and oversized records fail closed. Valid Unicode pairs, evidence text and SQL-shaped content remain bound data. Driver failures expose only `evaluation_data_persistence_failed`; invalid records expose `evaluation_data_persistence_invalid`. Original driver messages/parameters are not attached as causes.

The complete record round-trips, including source permission/provenance/review, case payload, answer context digest, expert contribution context digest/attestation, assessments and decision history. The store never generates review digests, upgrades approval or recomputes factual assessments. Structural validity is not authenticated review or factual correctness. Legacy missing review bindings may be stored as unapproved evidence; acquisition's current quality recheck rejects stale ready assessments before replay. This table stores the latest complete snapshot and accumulated decisions, not a separate authenticated review ledger or immutable historical copy of every revision. Trusted review adapters still own immutable evidence/consent snapshots and approval authority.

## Verification

Final strict selected eval harness:

```sh
node tests/track-b/run-checks.mjs --components evals --track-a-ref origin/track-a
```

Passed strict compilation and **19 files / 249 tests**, none skipped, including **38 new PostgreSQL store tests**. Final run read locally available Track A commit `c4bd22e177a6b14ecd9b505033b3a27dbdb0b061`, contract digest `67a98dc7ddab55f56223fe40b402edae6bd0edbab4d4d070a19706fc006ae915`; no fetch was performed. The new tests execute actual SQL against the migration in PGlite. PGlite serializes transactions: its Promise.all winner tests alone do not establish independent-session contention.

Acquisition tests use the actual store and fake providers/reviewers. They establish operation-key continuity across fresh service instances, preservation of decisions after pending retries, provider execution outside transactions, correctly bound completed replay, rejection of changed spec/initial evidence and rejection of wrong-question ready replay. Other tests cover tenant/job isolation, canonical spec equality after JSONB key reordering, stale revisions, malformed SQL rows, current policy changes, Unicode/NUL handling, lossless JSON and rollback after returned-row validation or policy failure.

Native PostgreSQL verification is a separate explicitly invoked offline runner:

```sh
TRACK_B_POSTGRES_RUNTIME=/tmp/agent-persistence-runtime \
  node packages/core/src/evals/data/persistence-migrations/verify-native.mjs
```

`TRACK_B_POSTGRES_RUNTIME` must point to existing `embedded-postgres` and `pg` dependencies; optional `TRACK_B_HARNESS` locates existing TypeScript/Zod dependencies. The runner never installs/downloads dependencies or accepts a remote database URL. It stages transpiled source in a temporary directory, starts a disposable loopback PostgreSQL server, applies only the migration there, uses existing `pooledCalendarDatabase`, closes pools, stops the server and removes its directory. No additional child agent was needed for this verification.

**6 native checks passed, none skipped**, using `embedded-postgres@18.6.0-beta.19` and `pg@8.23.1`. Eight distinct backend PIDs and a barrier after BEGIN ensure all independent pinned sessions have open transactions before insert/CAS SQL runs. Each race produced exactly one winner. Checks also cover identity conflicts, tenant/job isolation, native rollback after UPDATE failure, and a complete server restart followed by replay from a fresh pool. The verifier emits source/migration SHA-256 hashes. Migration SHA-256: `7f0eca2781e9b372d825fbc12a4364efadff226c03db11b52f12ca3d079b9ae9`.

The existing isolated DQ review runner copies all data modules but omits the newly required type-only `agents/postgres-ports.ts` dependency. That runner is outside this implementation's ownership. A temporary copy of its staging script added just that dependency to verify the DQ regressions without changing repository harness files: strict compilation and **6 files / 119 tests passed**, none skipped (81 existing acquisition/quality/review tests plus the 38 new store tests). The parent should add that staging dependency if retaining the isolated runner.

## Remaining wiring

The parent must export the factory, apply the migration through deployment authorization, supply a pooled database and trusted tenant/job scope, provide current safety configuration, and inject the store into `EvaluationDataPorts`. No Track A app/contracts/root manifests were edited. App/deployment/cloud behavior and production authorization/review-ledger authentication remain unverified. Durable provider-side operation-key deduplication is still necessary after ambiguous external calls; database CAS prevents storage overwrites, not duplicate provider execution.
