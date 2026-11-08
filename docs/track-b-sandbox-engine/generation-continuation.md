# Sandbox generation continuation

New opt-in factory: `createPostgresSandboxGenerationContinuation` in
`packages/core/src/evals/sandbox/generation/continuation.ts`. No existing adapter,
persistence, integration, app, runtime, migration or manifest is changed. The
existing permanent `bindOperation` fence remains intact.

## Exact parent adoption

Import the new factory directly (no barrel export has been added). Replace the
parent's construction of `createSandboxGenerationAdapter` for **new operations**
with:

```ts
const generate = createPostgresSandboxGenerationContinuation({
  db, // AgentTransactionalSql, pinned connections, commit before resolve
  service, // actual AgentSessionService using PostgresAgentTaskStore + PostgresBudgetLedger
  scope: { tenantId, jobId: job.jobId, environmentId }, // authenticated server values
  executionIdentity: 'generation-policy-v1:directory-pins-v1:namespace-v1:period-v1',
  authorize: async () => currentPrincipalOwnsTenantJobAndEnvironment(),
  job,
  sessionCapMicroUsd,
  jobCapMicroUsd,
  maxAttempts: 2,
  knownSecrets: () => currentAndRevokedCredentials(),
  onMeasuredCost: async entry => upsertMeasuredCostByTaskAndExternalId(entry),
  assessCandidate: async (candidate, operationKey) => assessWithExistingDurableGates(candidate, operationKey),
});
const result = await generate(originalRequest);
```

Names of parent authorization/cost functions above are illustrative ports, not new
APIs in this patch. Supply the existing SQL session/budget factories with the
existing provider port; this factory creates no provider, credentials or network
client. Keep all service configuration (directory and agent version pins,
idempotency namespace, budget period) stable across workers/restarts. The parent
must change `executionIdentity` when any of these or the gate execution policy
changes. Such a change conflicts for an existing operation; it is not permission
to start a replacement task. Gate approval remains a separate customer boundary.

The database must already have the existing agent persistence and text integration
checkpoint migrations. No new DDL. Transaction callbacks must roll back on error,
never retry automatically, and must resolve only after commit. Use the same
persistent database/scope and original request/operation key on every continuation.
Reconstruct the service per process with the same durable stores and immutable
execution contract; give each process its own service worker ID.

Do **not** apply the new namespace to an operation previously claimed by the old
persistence binder, even when the old operation appears pending. This factory
cannot prove whether that legacy callback dispatched work. The parent must route
legacy operations through operator reconciliation, and adopt this factory only
for operations known never to have dispatched through the legacy path. There is
no automatic legacy migration or takeover. Parent integration must enforce this
routing before invoking the new factory; it is intentionally outside owned files.

## Durable state and replay

* The immutable binding stores the screened full request and original adapter
  digest; its identity also includes the trusted execution contract. SQL claim and
  completion are one short transaction with no external callback. Concurrent
  identical bindings can succeed; changed input conflicts before provider work.
* Agent phase receipts bind exact prompt (including rejection feedback), output
  JSON schema, budgets, role, purpose and attempt. The adapter computes the same
  task key and revision purpose it used before this change. No retry identity is
  invented. Completed/terminal agent receipts replay without calling the provider.
* Only an actual `AgentSessionService` pending result carrying an adopted session
  ID permits continuation polling. A durable session receipt binds that ID; saving
  the receipt and releasing just the polling claim are atomic. The next invocation
  calls the same service/task, which resumes its durable adopted session. An
  unknown create (`sessionId: null`), exception or lost acknowledgement leaves the
  outer phase permanently pending. A competing worker observes the claim and
  blocks; it never takes it over by time or starts another revision.
* Each gate operation/candidate pair is permanently fenced before its callback.
  Passed, rejected and unresolved results all replay. Definitive rejection alone
  allows the existing adapter's bounded next revision. Replaying from revision
  zero reconstructs candidates, drops and feedback using durable receipts.
* Each measured cost entry is bound by task key and its entire immutable entry,
  including external session ID. A completed delivery receipt suppresses repeated
  callbacks. Unknown delivery acknowledgements stay fenced even if the sink is
  idempotent; this layer never guesses that delivery succeeded.

Authorization is checked before and after phases and external callbacks. Payloads,
including replayed receipts and final results, are screened under current and
retained secret values. Factories retain all secrets observed in that process;
new processes must also receive revoked credentials for historic coverage. Secret
values are never checkpointed by the continuation layer. This does not remove a
secret from historic agent task storage written before it became a known secret.
A newly detected secret prevents replay/dispatch and requires reconciliation.

## Deliberate limitations and handoff

There is no lease, timeout takeover, background scheduler, operator reconciliation
API, or new task identity. The caller schedules another invocation after an
ordinary pending result. Interrupted provider dispatch, session-receipt commit,
gate execution, cost delivery or uncertain database commit acknowledgement can
leave a permanent fence. Even if the underlying service might later recover an
unknown create with its own same-key protocol, this wrapper does not invoke it
without an authoritative saved-session result. This conservatism trades automatic
recovery of unknown effects for safety. A crash before any dispatch can also leave
a fence; absence of evidence is not permission to release it.

Existing gate replay should still be supplied inside the assessment port for its
own suboperations. This outer layer cannot atomically transact arbitrary external
effects with its receipts. Callbacks must not switch execution policy without
changing the trusted execution identity. The factory trusts server construction
of AgentSessionService and its durable dependencies; `instanceof` is an accidental
misconfiguration check, not attestation of provider/store correctness.

The root ledger and branch are intentionally not edited: this subtask explicitly
owns only new continuation source, new continuation tests and this document. The
parent should record adoption and validation in LEDGER.md during integration.

## Validation on parent 414eff5

The owned test harness copies the current working-tree source/spec/contracts to a
throwaway stage and runs strict TypeScript plus 11 SQL tests. It uses real native
PostgreSQL over a disposable Unix socket, separate worker connections, an actual
server restart, PostgresTextCheckpointStore, PostgresAgentTaskStore,
PostgresBudgetLedger and AgentSessionService. Only the provider and gate/cost
callbacks are fake; no network provider, cloud or paid calls occur.

```sh
TRACK_B_NODE_MODULES=/path/to/existing/node_modules \
CONTINUATION_PG_BIN=/path/to/existing/postgres/bin \
node tests/track-b/sandbox-generation-continuation/run.mjs
```

Dependencies must already contain TypeScript, Vitest, Zod, pg and their types;
native PostgreSQL must already be installed. The harness never installs or
silently skips. Results: strict staged typecheck passed; 11/11 tests passed, zero
skipped. Coverage includes pending-to-completed restart, full receipt replay,
changed-request conflict, competing workers during create and gate execution,
unknown create, lost gate/cost acknowledgements, unresolved gate replay, bounded
revision feedback replay, authorization revocation and secret rotation.

Requested repository checks were attempted: `npx tsc -p apps/web --noEmit` could
not resolve the workspace compiler; using the cached actual TypeScript compiler
confirmed missing Next/React/workflow/botid dependencies. `npm test` failed because
Vitest was absent at the repository root; supplying the cached executable still
could not resolve `vitest/config` from the root configuration. No repository-wide
pass or production acceptance is claimed. No dependency/manifests were changed.
