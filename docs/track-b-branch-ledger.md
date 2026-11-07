# Durable application branch ownership ledger

`PostgresBranchLedger` in `packages/core/src/simulator/branch-ledger.ts` implements the injected `BranchLedger` contract. It also supplies `findOwnedBranch(branchId)` for `createBranchServices`. Track A supplies a pg-style `SqlPool` (for example a Node `pg.Pool` or compatible Neon session driver) connected to the **application database**, and owns pool lifecycle/configuration. No driver dependency is added here.

The optional migration `packages/core/src/simulator/ledger-migrations/001_branch_ownership.sql` creates `app_branch_ownership`. Track A must review and incorporate it into its application migration sequence explicitly. It has not been applied anywhere by this implementation. Do **not** apply it to `sim-seed`, disposable job branches, or the simulator calendar migrations. The standalone table deliberately has no dependency on Track A schema/contracts or a particular jobs-table ID type. Its primary key is the job ID, and a unique nullable branch ID prevents claiming a branch for two jobs. Project/name pairs are also unique. Deleted records remain as ownership tombstones.

Integration (parent must export the class from `simulator/index.ts` if desired):

```ts
import { PostgresBranchLedger } from './simulator/branch-ledger.js';

const ledger = new PostgresBranchLedger(applicationPool);
const service = new NeonBranchService(neonApi, ledger, projectId, seedBranchId);
const branches = createBranchServices({
  service,
  findOwnedBranch: (id) => ledger.findOwnedBranch(id),
  connectionString: resolveTrustedBranchConnectionString,
});
```

The final argument requires Track A's trusted branch-specific URI resolver. The lookup includes deleted records; the existing branch service interprets cleanup state and re-verifies ownership before cloud mutation. It is an ownership lookup, not a readiness guarantee. Pass a closure as above to retain the ledger's method receiver.

## Durability and locking

Each `withJobLock` checks out one connection, acquires a **session-level** advisory lock using PostgreSQL's 64-bit `hashtextextended` over a namespaced job ID, reads current ownership, runs the callback, and explicitly unlocks before releasing. All reads/writes/lock operations within the callback scope use the same connection. Hash collisions cause extra serialization, not conflicting ownership. All application processes must use this same ledger/database/namespace. Reentrant calls for the same job are unsupported and can wait indefinitely.

There is deliberately **no BEGIN around the callback**. Every put is a parameterized, autocommitted INSERT/upsert; its promise resolves only after the driver resolves that statement. The existing Neon service awaits `creating` before POST, then awaits the branch ID/state update before returning. A callback failure cannot roll back an earlier intent. A crash or ambiguous POST therefore leaves `creating`, which the service must reconcile rather than blindly recreate. No cloud mutations are retried by this ledger.

Use a direct database connection or **session-mode pooling**. A transaction-mode PgBouncer/Neon pooled endpoint cannot preserve session advisory lock ownership across autocommits. Do not supply a client already inside an externally managed transaction. The pool/driver must treat each query outside a transaction as autocommitted and honor `release(error)` by destroying the connection. Standard PostgreSQL server durability settings must remain enabled. Track A must bound connection acquisition and provider-request deadlines operationally.

Queued puts are copied/validated at invocation and issued in invocation order; in-flight writes drain before unlocking even when the callback forgot to await them. Puts called after callback completion reject. Write failures fail the enclosing operation even if the callback swallowed the write error. SQL/connection failures expose fixed error codes without query parameters, raw server errors or connection URIs. Nothing is logged. Callback errors are preserved as supplied by the caller. Failed/ambiguous acquisition or SQL, failed/false unlock, and throwing release paths discard the connection. If release throws, the adapter attempts `release(error)` again; a broken custom pool that refuses to destroy connections requires pool-level remediation.

A live connection can fail while the callback is performing cloud I/O; a session lock is not a cloud fencing token. The durable intent still prevents a second blind POST after lock loss. Cleanup completion and reconciliation must remain idempotent. Ambiguous database writes are not automatically retried either.

## Validation and explicit retry states

Runtime validation checks every stored/read record and each write: bounded job/project/branch IDs, generated branch-name shape, exact state vocabulary, no branch equal to its seed parent, and required branch ID for ready/deletion states. `creating` and `retryable` have no branch ID. `createAttempts` is optional for legacy records and, when present, is an integer from 1 to 3. The migration stores it in a constrained `create_attempts` integer column; ownership uses typed columns rather than JSON. Absent counts are interpreted as 1 for transition checks.

The parent Neon service update must add `retryable` and optional `createAttempts` to `BranchOwnership`. For known-safe 423/503 responses it persists `retryable`, then a later caller may transition to `creating` with exactly one higher attempt count, at most 3. Ambiguous `creating` cannot increment its count. Other allowed transitions preserve count and identity: creating to retryable/ready/deletion, ready to deletion, delete_requested to deleted, or an idempotent same-state write. An established branch ID, project, seed parent and random branch name cannot change. Deleted cannot regress. The ledger only enforces durable transitions; the parent owns HTTP classification and retry dispatch. All writers must use this adapter; SQL administrators can bypass application transition checks.

Parent integration has applied the type/export changes. A known-safe 423/503 DELETE rejection also permits `delete_requested` to return to `ready`, retaining identity and attempt count; ambiguous or accepted deletion stays `delete_requested`. An added PostgreSQL integration test exercises create 423 → success and delete 503 → success through the real durable ledger. Invalid Unicode job identifiers are rejected before SQL.

## Verification and remaining integration checks

Tests use real PGlite PostgreSQL for the migration, constraints, parameterized upsert/lookup, committed intent surviving callback failure, fresh-ledger recovery without repeat POST, uniqueness, ownership/branch-ID immutability, state regression and bounded retry counts. PGlite has one session and advisory locks are intercepted. Injectable pg-style tests separately cover pinned acquisition/read/write/unlock ordering, put completion after query completion, escaped callback lifetime, swallowed write errors, failed unlock/release and connection discard. A simulated mutex test shows a second callback waits for lock acquisition; it is **not real PostgreSQL multi-session concurrency verification**. A fresh ledger instance is tested, not an operating-system crash/restart or disk recovery.

Result: 14 ledger tests plus 5 existing pool tests passed; strict TypeScript checking passed. Validated in an isolated `/tmp/branch-ledger-check.*` staging directory using the existing `/tmp/track-b-harness/node_modules`: TypeScript 5.9.3, Vitest 3.2.7, PGlite 0.5.15. The repository harness dependencies were not installed locally. The staging copy of `neon.ts` received only the parent's announced type additions (`retryable`, `createAttempts?`) so strict compilation could check this implementation before the parent update lands; repository `neon.ts` was not edited. The SQL recovery test exercises the existing ambiguous-POST path, not the parent's forthcoming 423/503 service behavior.

Before deployment, integrate the parent service/type/export changes, incorporate the migration through Track A, run `node tests/track-b/run-checks.mjs` with installed harness dependencies, and test two independent connections/processes against a disposable **application** PostgreSQL database for blocking and lock release after backend termination. Verify the selected endpoint is session-safe. No live Neon connections, migrations, cloud mutations or credentials were used here.
