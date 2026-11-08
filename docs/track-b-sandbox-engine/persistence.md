# Sandbox PostgreSQL persistence

`packages/core/src/evals/sandbox/persistence` supplies server-constructed persistence ports for the Track B sandbox engine. It reuses `PostgresTextCheckpointStore` and `text_integration.checkpoints`; no additional schema or migration is required. The existing migration at `packages/core/src/evals/integration/migrations/001-text-integration.sql` must already be installed by the application's migration process. This implementation does not apply migrations.

Construct `createPostgresSandboxPersistence` with a trusted PostgreSQL `AgentTransactionalSql`, immutable `{ tenantId, jobId, environmentId }`, a fresh authorization callback, and the application's current secret supplier. The database contract requires connection-pinned READ COMMITTED transactions, rollback on failure, and no callback retries. Never construct these options from model output. SQL and table identifiers are fixed; values are parameters. The SQL credential is a trusted server credential, not a customer or model credential. Namespace scoping protects adapter callers; it does not grant direct database access or replace application authorization.

The composition exposes `replay` for both `authority.replay` and `gates.replay`, `persistPrivateReport` for the engine authority, `readPrivateReport` for owner-authorized server reads, and `bindOperation` for generation. Retain the engine's existing authority checks, approval validation, budget admission and final snapshot bridge. Persistence authorization must independently resolve the current authenticated principal's ownership of the configured tenant, job and environment on every invocation. Reports contain private policy, SQL and transcript evidence; they are not public DTOs.

Every replay operation commits a permanent claim before invoking its callback. A changed digest under the same key fails. Completion is stored before returning and replay returns retained data without invoking the callback. A callback rejection, crash, lost acknowledgement, invalid result or revoked authorization can leave pending work; subsequent callers must reconcile it rather than dispatch it again. There are no leases, timeouts, takeover, automatic release, or public reconciliation endpoint. A completed database write with a lost acknowledgement remains replayable.

Generation binding deliberately grants only the first successful claim. A repeated matching binding returns `unresolved`, and changed identity returns `conflict`. The generation port has neither a completion receipt nor a durable continuation API, so returning `bound` on a pending restart could create fresh revisions or effects. Applications requiring generation restart must add a reviewed, durable continuation protocol; they must not delete or release the binding.

Private report upsert uses trial identity and an exact canonical report digest. Identical writes are idempotent; changed content or execution identity is rejected. Reads validate the persisted envelope, scope, payload schema, identity and digest, and screen retained data against the current secret configuration. Payload limits and strict JSON validation apply at persistence boundaries. Secret configuration must include every credential that must remain blocked after process restart, including retired credentials for the retention window; an in-process secret history is not a durable credential registry. Rotating credentials never authorizes disclosing a previously stored credential.

The optional execution checkpoint adapter is intentionally omitted. Execution keeps its existing `TextCheckpointStore` contract; the composition supplies gate/engine replay, private report storage and generation binding only. Wiring the new ports into the engine remains with the integration owner. Local SQL validation does not establish live model, Neon, Vercel, media, deployment or production acceptance.

## Contract and ownership preservation

This extension adds only `evals/sandbox/persistence/**`, `tests/track-b/sandbox-persistence/**`, and this document. It does not replace a complete source snapshot, edit either engine, or change app/assets/runtime bridge files. The historical Track A contract is `aa94505`; current upstream is `e99f8c4ad1ec7051f98d925e7fad87a0c05b0d4d`, which includes Track A's separate `sandbox/engine` and optional trusted `SandboxRun.exec(sql)` mutation hook. Its optional `ToolCallRecord.executed` field is retained by report validation. Persistence does not call `exec`, interpret tool SQL, or change the runtime's query-parameter behavior; that integration patch remains with its owner. Contract staging is disposable validation only and never overwrites the checkout.


## Server wiring

```ts
const persistence = createPostgresSandboxPersistence({
  db, // Existing connection-pinned AgentTransactionalSql.
  scope: { tenantId, jobId, environmentId }, // Trusted ownership binding.
  authorize: async ({ scope, operation }) =>
    authorizeCurrentOwner(scope, operation),
  knownSecrets: () => currentAndRetiredSandboxCredentials(),
});
// Pass persistence.replay to both authority.replay and gates.replay.
// Pass persistence.persistPrivateReport to authority.persistPrivateReport.
// Pass persistence.bindOperation to generation.bindOperation.
// Owner-only report route: persistence.readPrivateReport(trialId, identityDigest).
```

`readPrivateReport` returns null only for an absent record; pending, unauthorized, malformed, secret-bearing or conflicting records reject. `privateSandboxReportDigest` exposes the canonical exact-content digest for trusted callers. The default maximum encoded payload/envelope size is 4,000,000 bytes; the configurable ceiling is 16,000,000 bytes. JSON rejects undefined/nonfinite values, sparse arrays, accessors, coercion hooks and cycles. Envelope digests detect accidental/tampered payload changes; they are not signatures against a compromised database administrator.

## Validation evidence

Both commands passed strict TypeScript checking and **14 native PostgreSQL tests**, zero skipped, using the already installed local `embedded-postgres@18.6.0-beta.19` runtime. Tests compare independent connection backend PIDs and stop/restart PostgreSQL between seed and replay workers.

```sh
node tests/track-b/sandbox-persistence/run.mjs
TRACK_A_REF=e99f8c4 node tests/track-b/sandbox-persistence/run.mjs
```

- Historical contract: `aa94505fd535f5c0f586cc6325b49b71a1683761`; spec SHA-256 `71ae878f2fd00fb71a82a1310afeee1c490c7cade6cddb903e19bb2dbb147ffe`.
- Current upstream contract: `e99f8c4ad1ec7051f98d925e7fad87a0c05b0d4d`; spec SHA-256 `409ba09097bd8b91469a2e327a4964ed5b8b3b5b404826d58fb5a7617756e92d`.

Coverage: tenant/job/environment separation; changed identities; concurrent claims and immutable writes; completed and failed-callback restart replay without effects; authorization revocation after SQL reads and during effects; stored-envelope/schema/digest tampering; current and retained secret screening, including rotation during a callback; malformed/oversized JSON; wrong report scope; and permanently unresolved generation resumes.

The harness uses existing local dependencies only. Override `TRACK_B_NODE_MODULES` (default `/tmp/sandbox-generation-deps.cBCEai/node_modules`) and `SANDBOX_PERSISTENCE_RUNTIME` (default `/tmp/agent-persistence-runtime`) to point to already installed tooling/native PostgreSQL. No dependency installation, network/provider/cloud call, application migration, push or deployment occurs. Disposable local test databases receive the existing checkpoint migration. Fixture persistence tests do not establish full integrated engine acceptance. Independent read-only review found no remaining blocking issue after environment binding and fractional timing compatibility were corrected.
