# Durable public discovery persistence

Import directly from `packages/core/src/evals/data/discovery/persistence/index.ts`. This addition does not modify discovery, shared exports, application wiring, contracts or manifests. It implements `DiscoveryOperations` for the current bounded MediaWiki discovery result contract.

```ts
import { createPostgresDiscoveryOperations } from './evals/data/discovery/persistence';
import { createMediaWikiDiscovery } from './evals/data/discovery';

// Server-only composition, AFTER authentication and an authorized job lookup.
// These values must never come from request.task, request.operationKey or posted tenant/job IDs.
const operations = createPostgresDiscoveryOperations({
  db: applicationTransactionalSql,
  authenticatedScope: { tenantId: authenticatedTenant.id, jobId: authorizedJob.id },
  knownSecrets: applicationKnownSecrets,
});
const { discover } = createMediaWikiDiscovery({
  providerOrigin: 'https://en.wikipedia.org',
  queries: operatorSelectedQueries,
  operations,
  knownSecrets: applicationKnownSecrets,
});
```

The application must authenticate the tenant, authorize ownership of the job, and supply a trusted `AgentTransactionalSql`. No runtime brand can authenticate a caller-supplied string. Do not expose these factories or adapter objects as arbitrary RPC endpoints. Construct an adapter per authorized worker/job execution; use the same object for its claim and completion. It is safe for that object to receive concurrent claims. Separate workers construct separate objects with identical authenticated scope. The scope and known-secret list are copied at construction.

`createDiscoveryOperations({ store, authenticatedScope, knownSecrets? })` is the lower-level injectable factory. Its `TextCheckpointStore` must obey the same durable atomic claim, immutable input digest, token ownership and completion comparison contract as `PostgresTextCheckpointStore`. An in-memory map is not a production substitute.

## Storage and ownership

Apply the existing `evals/integration/migrations/001-text-integration.sql` through the application's migration process before use. No new migration is required. `db.transaction` must pin a connection, use READ COMMITTED, roll back failures, and never retry its callback. This adapter runs no DDL, provider call, DNS lookup, network request or paid operation.

The checkpoint schema has no tenant column. Its `job_id` is instead `discovery:v1:<sha256(JSON tuple(domain, authenticated tenant, authorized job))>`. `kind` is reserved as `public-discovery-v1`; `id` is a separate domain-separated SHA-256 of the operation key. JSON tuple framing distinguishes delimiter-containing scopes. Do not write other checkpoint purposes to this namespace, release its checkpoints or delete them while replay is required. Hashing identities prevents accidental raw identifier storage; it is not encryption or a substitute for database access controls/RLS. The application database role remains trusted.

Keys/scopes must be nonblank strings of at most 1024 UTF-16 units, without control characters, lone surrogates, detected secrets or PII. Digests must be lowercase 64-character hexadecimal SHA-256 values, matching the discovery producer's `reviewDigest`. Equal operation keys with different digests fail closed, before any external dispatch.

Only the database winner receives `claimed`. Its random owner token stays private to the adapter. Concurrent pending responses never clear or overwrite that token. Other instances cannot complete a pending operation. The underlying SQL locks and checks ownership again during completion. Tokens remain in the owning adapter for its job lifetime to support repeated completion, including a committed write whose acknowledgement was lost. Memory use grows with unique claimed operations; discard the adapter when that worker execution ends. There are no timers or leases.

Fresh instances replay completed data through `claim`, without needing the old token. `complete` on a fresh instance is deliberately rejected: durable replay does not confer write authority. An owning instance can retry identical completion; SQL jsonb equality under a row lock allows object-key reordering but rejects changed data. Returned results and submitted completions are detached copies. A completion failure retains ownership and never releases the claim.

## Result boundary and errors

Completion and replay both validate strict plain JSON and the current public candidate envelope: at most five sources, at most 80,000 content characters, at most 500,000 encoded bytes, no cases, unique safe source IDs, public HTTPS source/license URLs, content SHA-256, public provenance with a parseable retrieval timestamp, unknown permission with no allowed uses, and pending review with no reviewer identity or review timestamp. Unknown fields, approvals, invalid types, cycles, accessors, custom prototypes, undefined/nonfinite values, NUL/lone surrogates, detected secrets and PII fail closed. Valid Unicode pairs remain supported. Empty batches are valid durable results. This is intentionally specific to current public discovery; other discovery providers returning cases or different permission/review shapes need an explicit reviewed extension.

Persistence does not verify factual content, grant permission, or approve evidence. The discovery producer additionally binds results to its configured origin, revision URLs and producer identity. Keep its validation and the downstream independent review gates enabled. Known-secret/PII checks are conservative admission screens, not proof that arbitrary text contains no private data.

Errors expose only `discovery_persistence_` codes: `invalid_identity`, `input_conflict`, `not_owner`, `completion_conflict`, `ambiguous`, `invalid_result`, or `storage_unavailable`. Raw storage exceptions, SQL parameters, connection strings and original causes are discarded. Handle `storage_unavailable` conservatively: retrying a claim is safe, but do not infer dispatch permission from a failed claim or completion.

## Recovery and integration limits

A pending claim survives process death. If the worker crashes after claiming (even before dispatch), subsequent workers return pending indefinitely. Ambiguous checkpoints also return pending. There is no automatic expiry, takeover, release, resend or claim deletion. An operator must reconcile external activity independently; this module deliberately offers no reconciliation mutation API. Never clear a claim merely because it is old. Retain checkpoints/results for the entire promised idempotency window.

Application authentication, authorized job lookup, database provisioning/migration application, encrypted storage/retention policy, Workflow composition, and operator reconciliation remain integration responsibilities. No application routes or shared exports were changed. SQL tests use local PGlite's real PostgreSQL semantics on one serialized connection; they do not prove multi-connection PostgreSQL contention or production isolation configuration. No cloud/provider verification was run.

## Verification

Run `node tests/track-b/run-checks.mjs --components evals --track-a-ref origin/track-a`. The owned `persistence/persistence.test.ts` suite exercises SQL-backed concurrent claim/completion races, delayed same-instance pending responses, reconstructed adapter replay, tenant/job separation, immutable digest conflicts, stale token rejection, pending/ambiguous recovery, lost completion acknowledgements, unsafe input rejection and corrupt replay rejection. It uses authored fixtures only.
