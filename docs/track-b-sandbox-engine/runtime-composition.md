# Durable runtime composition

`createDurableRuntimeComposition` in `evals/sandbox/runtime-composition` closes the previously manual connection between `retainRuntimeRun`, `createDurableRuntimeSnapshots` and the engine's `authority.finalSnapshot` method. It is an additive trusted server adapter. It does not install application runtime ports, issue policies, run migrations, deploy, or create hosted resources.

Construct one composition with an authorized `RuntimeStorage`, a durable `resolvePolicy` lookup of independently preissued exact row grants, and the same bounds and synchronous receipt guard documented in [runtime-storage.md](runtime-storage.md). The repository must be scoped to the authorized tenant/job/environment. The complete-image screening policy and current/retired secret registry remain mandatory repository responsibilities.

```ts
import { createDurableRuntimeComposition } from '@ae/core/evals/sandbox/runtime-composition/index';

const retained = createDurableRuntimeComposition(snapshotConfig);
// In the trusted runtime allocation port, immediately after raw allocation:
const handle = await retained.retain({
  run: rawRun,
  binding: { worldId, executionIdentity, environment, scenario, versions },
  source: actualOwningPGliteDatabase,
});
// Return handle.run to execution; keep rawRun and its database private.
// In createDurableSandboxEngine config:
// authority: { ...authority, finalSnapshot: retained.finalSnapshot }
```

The allocating owner supplies the original execution identity and full bindings and disposes the raw run if retain fails. Every operation must use the returned run. The bridge serializes accepted operations and rejects late writes while sealing. The composition observes precisely the diff, trajectory and outbox calls made by the bridge during that quiescent seal, rather than independently sampling or reconstructing rows. Publication takes one full data-directory dump. The bridge's image is constructed from the exact persisted bytes after verifying the complete publication record and image digest; it never dumps the live database twice. Repeated disposal/sealing uses the original bridge's memoized promise, including failure.

Policy lookup happens before operations, and the bridge receives that detached policy. Publication and recovery independently recheck it through the storage adapter. No grants are derived from actual writes. Missing preissued authority remains absent and collateral grading remains unknown.

`finalSnapshot` snapshots its input before awaiting, checks the environment hash, exact run/world/execution/scenario/version binding and all diff samples, calls and outbox receipts against the durable record, then opens the actual persisted PGlite image through authorized recovery. First-process grading uses that same recovery path, so retaining an in-memory bridge cannot bypass fresh authorization or secret checks. It implements the nonnullable engine authority contract: absent records throw rather than fabricate an empty world. Revocation or inconsistent records also reject. Callers must release every successful snapshot.

After restart, construct a fresh composition over the same scoped repository and pass the original durable execution artifact to `finalSnapshot`. No run registry reconstruction, runtime allocation, provider call or redispatch occurs. The existing durable engine owns whole-trial dispatch fences and report replay; this factory neither replaces nor weakens them. A crash before snapshot publication remains unresolved under those fences. This is snapshot recovery, not an execution takeover API.

`handle.gateSnapshot()` similarly seals and recovers authorized durable evidence for the exact gate run. `handle.forget()` only removes the bridge's local image after disposal; the repository's explicit retain/releaseRetention/reap operations remain the lifecycle owner's responsibility. This adapter does not silently release durable retention. Duplicate retain attempts under a process-local run ID fail, including after failed preparation.

## Verification

`node tests/track-b/sandbox-runtime-composition/run.mjs` reuses the existing local PostgreSQL/PGlite dependencies and stages current B source with exact committed A runtime modules. It performs strict TypeScript compilation and runs separate seed/recovery workers with native PostgreSQL stopped and restarted between them. No dependency installation, provider calls, cloud access or production migration is involved. Fixture image screening is deliberately restricted to known fixture data; it is not a production binary-content policy.

Tests cover actual A runtime mutation/disposal, one dump, actual grader invocation through composed finalSnapshot before and after restart, assignability to the engine authority method, receipt/world conflicts, post-recovery revocation and secret rotation, and unknown collateral verdict without independently issued policy. They do not run a second full durable engine trial; existing durable-engine suites own whole-engine replay acceptance. Results are recorded after execution below.

Root ledger, Git writes and integration are owned by the parent agent; all changes here are confined to the three assigned new paths.

Validation completed: strict staged TypeScript and **4 native PostgreSQL/PGlite tests passed, zero skipped**, using committed A `dc73f769f63e6ce6a117e176e53e26bec994a4a0` and current B source. The seed/recovery workers were separated by a full native PostgreSQL stop/start. The cleanup assertion also verifies durable recovery after forgetting the local bridge image; the process-local registry retains only a lightweight exact-binding tombstone thereafter.

The runner uses a short `/tmp` directory because macOS's default temporary path exceeds PostgreSQL's Unix socket path limit when combined with the descriptive stage name. An initial attempt passed compilation but never started native PostgreSQL; no assertions from that attempt are counted. Its owned stage was removed. The successful runner removed its own temporary stage and database.

Required repository-wide checks were attempted offline: `npx tsc -p apps/web --noEmit` resolved the unrelated cached tsc shim because the workspace compiler is absent, and `npm test` failed because Vitest is absent from the workspace. No whole-repository test/build pass is claimed.
