# Read-only release registry reconciliation

This local planner compares the exact supplied release manifest, hashes of SQL bytes, and a trusted owner-exported durable registry. It does not apply SQL, connect to a database, load credentials, contact cloud services, or write a registry. Historical release artifacts remain unchanged. An alias match establishes identity evidence only: it proves no schema, grants, backfill, cost reconciliation, or hosted acceptance condition.

The release input is `docs/track-b-judged-release/MIGRATIONS.json`: 31 application migrations and one separate `isolated-calendar-only` migration. The two full-ID aliases are:

- `app.workflow-finding-reruns.006` → `app.workflow-finding-reruns.008`
- `app.workflow-comparison.006` → `app.rich-comparison.006`

Neither filenames, numeric prefixes, historical rename paths, nor SQL basename discovery establish registry identity. Application ledger SQL remains on the application database despite the simulator component in its source path. Calendar SQL remains separate.

## Run

Use a reviewed, already composed SQL release directory containing every manifest `sourcePath` and application `canonicalPath`. No staging/build helper is called by this tool. Relative paths are relative to that SQL root, including artifact-origin entries; arrange those files explicitly if your packaging layout differs. The simulator has only its source copy.

```sh
node docs/release-registry-reconciliation/cli.mjs \
  --manifest docs/track-b-judged-release/MIGRATIONS.json \
  --sql-root /absolute/real/path/to/composed-release \
  --registry /absolute/real/path/to/owner-export.json
```

Optional `--scope-decisions /absolute/real/path/to/decisions.json` supplies reviewed exact exclusions for unknown IDs. No other arguments, executable commands, connection strings, or environment configuration are accepted. Exit 0 means a structurally consistent *advisory comparison*, 2 means blocked issues, and 1 means usage/JSON/filesystem error. JSON goes to stdout; errors go to stderr. Exit 0 can include pending SQL or reconciliation proposals and never means accepted deployment.

All SQL paths must be normalized relative POSIX paths without `..`, `.`, empty components, backslashes, colons, or NUL. Files must be regular; symlinks are refused throughout input paths, including ancestors. On macOS use `/private/tmp/...` or `/private/var/...` rather than symlink aliases. Read exact bytes, without newline or encoding normalization. Source and canonical copies must both match the manifest SHA-256. Inputs are read again to detect changes observed during the comparison; output includes their hashes. The CLI writes no files. Use an immutable local snapshot: these checks cannot eliminate a malicious concurrent filesystem replacement or a registry change after export.

## Exact owner export seam

There is deliberately no automatic database export adapter: the repository does not establish the owner's durable registry table, column semantics, or trusted host identity. The database owner must implement and review the local export using their existing process. Do not query a guessed registry or copy packaging assertions into applied records.

Supply one JSON document with this shape:

```json
{
  "format": 1,
  "exportedBy": "owner/process identifier with externally verified provenance",
  "databaseRefs": {
    "application": "stable nonsecret physical database identifier",
    "isolated-calendar-only": "different stable nonsecret physical database identifier"
  },
  "records": [
    {
      "id": "app.baseline.0000_init",
      "database": "application",
      "sha256": "de78983ca0f120af848c8c27bd012a2a4711de270ca87e536b1e0fdf8982c62e",
      "state": "applied"
    }
  ]
}
```

The row above illustrates a shape; it is not applied evidence. `EXAMPLE-EMPTY-EXPORT.json` is also explicitly synthetic. No hosted export or hosted acceptance was obtained for this implementation.

Export **all rows**, retaining duplicates, incomplete/inflight/failed records, and unknown full identities. Map database labels from trusted physical database connections, not from filenames. Require both database references, distinct from each other, even when one has no rows. Export one consistent snapshot across the selected registries under owner coordination; preserve SQL content digests from the registry's original application records. Do not compute an alleged *applied* hash from today's SQL file. If the existing registry lacks full ID, content digest, or unambiguous completion state, export the incomplete evidence and investigate; do not fill the gap by inference. Only `state: "applied"` is complete. Other states block.

Trust is an external precondition: `exportedBy` and the database references are required metadata, not cryptographic authentication. The tool cannot establish that a JSON file came from the owner or is exhaustive. Keep provenance/snapshot metadata in the owner's review record, without secrets. Preserve JSON object key uniqueness before supplying files (the standard JSON parser uses the last occurrence of repeated object keys); registry duplicate *rows* are detected and block.

The pure API `planReconciliation({manifest, inventory, registry, scopeDecisions})` performs no I/O. Its inventory is an array of `{id,database,sourcePath,canonicalPath,sourceSha256,canonicalSha256}` derived from content; omit canonical fields for the simulator. This API assumes its caller actually hashed trusted bytes. The CLI builds this inventory itself. Manifest IDs, dependencies, aliases, paths, database labels, transaction owners (`runner`, `artifact`, `owner-existing-process`), and hashes are checked. It accepts alternate structurally valid manifests for fixture testing; callers must independently pin the expected release manifest hash. The output records the exact supplied manifest digest; it does not authenticate the release.

## Interpret the three work lists

`pendingMigrations` contains full identities absent from the registry, in dependency order, with transaction owner and exact hash/path information. Pending predecessors may appear earlier in the same plan: `ready` means the ordered plan has no detected blockers, not permission to run every entry independently. Known incomplete, wrong-database, conflicting, duplicate, or alias rows are never scheduled as pending SQL. An applied entry whose dependency lacks verified applied evidence blocks; later SQL cannot repair the historical evidence gap automatically.

`blockedIssues` contains metadata, content, registry, dependency, scope, and ambiguity failures. A blocker fences the entire release: pending entries have `ready:false`; reconciliation proposals are suppressed. Malformed structural inputs may return only issues. Duplicate canonical-plus-alias records block even when their hashes agree. No row is silently collapsed or deleted.

`reconciliationProposals` contains exact identity-only proposals with `fromId`, `toId`, `database`, `sha256`, `state`, `transactionOwner`, and `executeSql:false`. They require one unique alias record, an exact hash, an applied state, verified applied predecessors, and no blockers. A proposal never reruns the SQL. `appliedMigrations` records evidence matched to canonical IDs; it is advisory if any issues exist. The calendar migration participates only in its separate database.

Unknown IDs block by default. An owner may explicitly exclude an unrelated row using a JSON array:

```json
[
  {
    "id": "other-release.full-identity",
    "database": "application",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "state": "applied",
    "decision": "exclude",
    "reason": "Owner reviewed this unrelated release; retained in its separate release scope"
  }
]
```

Every exclusion binds the exact full ID, database, hash and state. Stale, duplicate, malformed, unused, or known-ID exclusions block. Exclusions cannot waive conflicts or dependencies. Unknown rows are never treated as applied prerequisites. There is no include-by-number or broad ignore flag.

## Owner handoff and locking

Before any separate executor acts, the owner must acquire the durable registry's **exclusive owner lock**, stop incompatible writers where required by the release, re-export/re-read the registry, verify provenance and database references, rehash the exact pinned manifest and every SQL byte, and rerun this comparison **while holding that lock**. Revalidate every proposal's exact source row, absence of a canonical/second alias row, completion state, digest and predecessors. Keep the lock through any owner-approved atomic registry identity reconciliation and through migration ordering decisions using the existing durable runner. This tool provides no executor or mutation statements. A printed proposal is never authorization to mutate a row later using stale evidence.

Revalidate the release's separate same-engine/same-role catalog, schema, grants, backfill, cost and runtime preflight requirements. Preserve transaction ownership: runner-owned artifacts need their existing pinned transaction behavior; artifact-owned SQL needs its existing idle dedicated session with no outer transaction; baseline ownership remains the owner's existing process. None of these operational or hosted conditions is established by this planner.

## Verification

```sh
node --test tests/track-b/release-registry-reconciliation/*.test.mjs
```

Tests use the actual immutable 31-entry manifest with explicitly synthetic registry/hash inventories, plus small local SQL fixtures for CLI hashing, path handling, and unchanged-byte checks. They do not claim hosted acceptance. Existing judged-release packaging tests remain untouched.
