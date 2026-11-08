This additive owner artifact closes the local registry adoption/execution interface; it does not apply anything to the application, platform, production registry or cloud. It is pinned to the repository observation in `PIN.json`, the exact judged manifest bytes, and the new composed `MIGRATIONS.json`. Historical artifacts and the existing reconciler are unchanged. Importing the API does not connect, load environment files, read database configuration or run SQL.

The composed manifest preserves all 31 judged application entries, both exact full-ID aliases and the separate calendar entry. Five additional application migrations have explicit ordering (full hashes in `PIN.json`):

| Identity | Required predecessors |
| --- | --- |
| `autonomy-release.operations` | `app.agent`, `app.data002` |
| `autonomy-release.communications` | `autonomy-release.operations` |
| `autonomy-release.access` | `autonomy-release.communications` |
| `app.autonomy-paid.001` | `autonomy-release.access`, `app.agent` |
| `app.autonomy-paid-authority.001` | `autonomy-release.access`, `app.autonomy-paid.001` |

The first three retain the IDs in the prior adoption stage's `owner-migrations/autonomy-release.json`. Its abstract prerequisites `agent.persistence.001` and `data.operations.002` map here explicitly to judged `app.agent` and `app.data002`. The paid-operation fence receives the new identity `app.autonomy-paid.001`; authority retains its declared identity. SQL comments and historical basenames are not registry aliases. The only accepted aliases remain those from the judged manifest. If an owner's registry uses other identities, stop and review a new explicit manifest; do not rename or infer them.

Build a NEW local SQL package from an already reviewed composed release stage, without invoking historical staging scripts:

```js
import {composeSqlRoot} from './compose.mjs';
composeSqlRoot({reviewedStage:'/absolute/real/reviewed-stage',output:'/absolute/real/new-sql-package'});
```

This checks every source hash, copies the five pinned SQL additions, and creates canonical SQL copies in a destination that must not already exist. It never overlays an app. All input ancestors must be real directories (use `/private/tmp`, not the macOS `/tmp` symlink). Review immutable package bytes and keep them immutable through execution. Hash checks detect observed changes; they are not a defense against a hostile filesystem owner.

`owner.mjs` is the production handoff API; `executor.mjs` also accepts alternate explicitly pinned manifests for independent fixture tests. The owner provides a **connected, exclusively held native PostgreSQL Client**, never a Pool/query router, using their separately authorized connection process. Use a direct/session-pinned connection, not transaction pooling. The owner must independently verify the cluster system identifier, database name/OID and current role, then supply `expectedIdentity`. The executor checks those against PostgreSQL, on the same backend that holds the session advisory lock and executes the SQL. A cluster clone can retain the system identifier: trusted connection routing and provenance remain owner responsibilities.

The authoritative existing registry is an explicitly supplied `schema.table`, with readable/writable `id text`, `database text`, `sha256 text`, `state text` columns. Its label must describe the physical connected database. Extra required insert columns/triggers or incompatible column semantics require a reviewed owner adapter revision; the executor does not guess them. It does not create a registry, reconstruct applied hashes from current files, bootstrap baselines, delete duplicates, backfill policy/authority values or repair schema drift. Unknown rows, incomplete states, duplicates and conflicting hashes block the whole selected database. A missing baseline requires the owner's existing baseline process and genuine original registry evidence.

Choose one stable signed-bigint advisory `lockKey` shared with **every** owner migration writer to this database. Stop incompatible writers before historical cost reconciliation and catalog preflight. Table locking also fences ordinary registry writers during each applying transaction, but cannot protect against independent schema writers that ignore the advisory protocol. Application and calendar database runs are separate, each with its own authoritative registry and independently verified connection. No cross-database atomicity or remote registry evidence is inferred.

Start with the read-only API, review the returned actions, identity and digests, then explicitly authorize the exact plan:

```js
import {ownerPlan,ownerApply} from './owner.mjs';
const config = {
  client, // already connected by the owner's trusted process
  sqlRoot: '/absolute/real/new-sql-package',
  database: 'application',
  registryTable: 'owner_schema.migration_registry',
  lockKey: '781044221', // example only; coordinate with every existing writer
  expectedIdentity: {
    systemIdentifier: '<independently verified cluster identifier>',
    databaseName: '<verified database>', databaseOid: '<verified OID>',
    currentUser: '<verified owner migration role>'
  }
};
const plan = await ownerPlan(config); // default; no DDL or registry mutations
// Owner reviews blockers and exact ordered actions, then authorizes separately:
const result = await ownerApply(config, {
  authorize: true,
  expectedRegistrySha256: plan.registrySha256,
  expectedContextSha256: plan.contextSha256,
  approvedActions: plan.actions
});
```

Never blindly chain plan into apply in a startup path. No CLI apply flag, automatic deployment hook or credential loader is provided. Explicit alias actions change exactly one matching applied row to its declared canonical full ID; they execute no SQL. Canonical-plus-alias duplicates block even when hashes match. Each completed migration and its registry insert commit together; a failed action rolls back. Earlier committed migrations remain complete, so after interruption obtain a fresh plan rather than replaying stale approval.

Owner configuration and authorization still required: authoritative registry schema/semantics and original evidence; trusted native connection and physical identity; coordinated exclusive lock and writer shutdown; exact manifest/SQL review; same-engine/same-role catalog and existing-object preflight; backups and maintenance window; server-only grants; then approval of the returned actions. The migration role needs CONNECT, registry schema USAGE and table SELECT/INSERT/UPDATE plus table-lock authority, permission to execute `pg_control_system()` for identity verification, CREATE on the application database for new schemas, and ownership/ALTER/CREATE privileges on affected schemas/tables. Use a dedicated migration role. The application server role needs only reviewed USAGE and SELECT/INSERT/UPDATE/DELETE on the exact runtime tables and any required sequence privileges. Never grant schema CREATE or registry mutation to customers/models; never infer grants from a table's existence. Operations/communications SQL does not establish server-only ACLs itself; the owner must revoke PUBLIC and review grants for **all** existing and new autonomy objects before application access.

Existing release bindings retain NULL authority and remain disabled until the owner explicitly reauthorizes immutable policy and paid caps. Registry adoption proves identity and exact execution evidence only. It does not prove permission issuers, provider receipts, paid authorization, hosted contention/recovery, rollout acceptance or deployment readiness.

Verify locally without external services:

```sh
node --test tests/track-b/migration-registry-adoption/pin.test.mjs
node tests/track-b/migration-registry-adoption/run.mjs --runtime /absolute/path/to/already-installed-native-postgres-runtime
node --test tests/track-b/release-registry-reconciliation/*.test.mjs
```

The runtime must already contain `pg` and the platform `@embedded-postgres` binary package. The native harness creates a disposable Unix-socket-only cluster, uses distinct backend sessions, forcibly terminates an in-flight backend, restarts the local server, and removes its files. It never installs packages or reads DB URLs. See `VERIFICATION.md` for actual results and limits.

The catalog guard checks supported CREATE relation and ADD COLUMN targets and rejects unsupported relation syntax; it allows shared existing schemas. This targeted guard is not a general SQL sandbox or complete catalog validator. Function/DO bodies, broader schema drift, grants and operational prerequisites still require the release's independent owner preflight. Unsafe SQL or existing-object checks may throw during read-only planning rather than return a blocked plan; both outcomes prohibit apply.
