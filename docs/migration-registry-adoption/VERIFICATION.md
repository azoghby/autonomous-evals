Local verification only; no production connection, providers, spend, secrets, deployment or hosted acceptance.

- Native PostgreSQL: **12/12 passed, zero skipped**, using the already retained `/private/tmp/agent-persistence-runtime` runtime, fresh disposable Unix-socket-only cluster, distinct PostgreSQL backends, fsync/synchronous_commit/full_page_writes enabled. Transcript: `tests/track-b/migration-registry-adoption/NATIVE-RESULTS.log`.
- Manifest/composition Node tests: **2/2 passed**. Preserve original 31 application entries, aliases and calendar exactly; verify extension hashes/dependencies against original adoption artifacts and every packaged source/canonical byte. Modified source refuses before packaging output creation.
- Existing unchanged release registry reconciler: **49/49 Node tests passed**.
- `node --check` executor, owner API and composer: passed. Scoped `git diff --check`: passed.
- `npx --no-install tsc -p apps/web --noEmit`: unable to run genuine TypeScript compiler; this worktree has no installed TypeScript (npx reports “This is not the tsc command you are looking for”). Offline/no-install option honors the no-network instruction.
- `npm test`: cannot start, `vitest: command not found`.
- `npm run build`: cannot start, `next: command not found`.

Native cases: read-only default and explicit authorization; exact alias skip/hash mismatch; canonical-plus-alias duplicates, unknown/incomplete rows and missing historical dependencies; changed SQL/manifest/registry/DB identity/action refusal; atomic DDL/registry rollback; refusal of unregistered existing objects; transaction-control/comment bypass refusal; exact five SQL additions applied with NULL authority preserved; artifact-owned wrapper success/rollback; independent owner lock contention and stale approval refusal; killed backend and immediate server restart with rollback and safe fresh-plan retry.

The native tests use narrow synthetic manifests for adversarial cases and the five exact additional SQL files. They do not apply the complete judged baseline or certify current application startup, hosted grants/catalog equivalence, external provider atomicity, cloud behavior, or production acceptance. The executor is a reviewed-release runner with targeted SQL safeguards, not a sandbox for arbitrary SQL. Opaque function/DO bodies, grants and broader schema drift still require owner catalog/source review. The owner must supply genuine original baseline registry evidence and use the pinned owner wrapper; no test fixture registry is applied evidence.
