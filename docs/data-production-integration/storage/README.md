# Shared operation ledger

`packages/core/src/evals/data/postgres-operations.ts` exports
`createPostgresDataOperationLedger(db, scope): DataOperationLedger` and the
`PostgresDataOperationScope` / `DataOperationReconciliation` types. Import the
module directly: this scoped change intentionally does not edit the barrel.

```ts
const operations = createPostgresDataOperationLedger(db, {
  tenantId: authorizedJob.tenantId,
  jobId: authorizedJob.id,
  ownerId: 'evaluation_data_service',
  authenticateOwner: async () => trustedServiceAuthentication.currentDataService(),
  knownSecrets: () => currentServerSecretPolicy.values(),
});
```

The two application dependencies above are names illustrating host obligations,
not repository APIs. The intake composition patch uses the existing host auth
and SQL primitives. `authenticateOwner` returns `{ ownerId } | null` from trusted
server service configuration/authentication. It must never read the principal
from a candidate, model output or request body. Keep this service capability
stable across replicas and process restarts: acquisition, human-intake storage,
review replay and cost capture share it. The human review principal still comes
separately from `createAuthenticatedDataReviewLedger.authenticateHuman`; a service
owner is not a reviewer and cannot confer review approval.

The factory pins tenant/job/owner and callback references. Every mutation checks
current service authentication. Reads are limited to the pinned tenant/job and
require trusted possession of the server-only adapter. Do not expose its generic
claim/complete methods or DB credentials to a browser/model. The authenticated
human route only invokes the existing review-ledger submit API after job/session
authorization. Candidate review, target/generator independence, immutable payload
binding, initial imported approval stripping and freeze validation remain in the
existing services.

Apply `002-data-operations.sql` manually with the migration role. Runtime code
never applies it. Its primary key elects one permanent claim owner, and a trigger
blocks deletion or mutation of identity, owner, completed result or receipt. There
are no leases, expiry fields, takeovers, cleanup or timer retries. `db` must provide
pinned READ COMMITTED transactions with rollback on throws and no callback
retries (`pooledCalendarDatabase` satisfies this). Provider calls occur outside
SQL transactions. SQL failures surface fixed diagnostics only.

If dispatch/commit acknowledgement is lost, `claim` returns `claimed:false` and
the pending row remains pending. The host must return reconciliation-required,
not re-dispatch generation. A worker possessing the same authenticated stable
owner can persist the already observed result. A different authenticated owner
requires a receipt and `authorizeReconciliation(input)` returning true for the
entire tenant/job/key/request digest/result digest/original owner/completing owner
binding. The receipt verifier must consult authenticated durable provider or
operator evidence; a string, model judgment or elapsed time is insufficient.
No default verifier is supplied. It runs inside the pinned completion transaction
and should use already available durable evidence without provider dispatch.

Completion is idempotent only for the identical result and receipt (including
receipt omission). JSON object key order is canonicalized for result comparison.
A completed reconciled operation cannot subsequently drop or change its receipt.
This strengthens the reference file adapter's receipt handling to meet immutable
production receipt requirements. Authenticated reconciliation still runs on
receipt-bearing replay. Both pending and complete records are validated under
current secret policy. Strict JSON rejects getters, custom serialization,
nonstandard prototypes, sparse/extra-property arrays, symbols, cycles, undefined,
non-finite numbers, NUL, lone surrogates, depth over 64 and payloads over 1 MB.

# Offline verification

`postgres-operations.test.ts` uses actual PGlite SQL and existing review/cost
adapters. PGlite serializes transactions; its concurrent promise tests do not
claim independent backend sessions. Tests cover lost claim/completion commit
acknowledgements, no second dispatch, owner/auth boundaries, tenant/job pinning,
exact receipt immutability, durable authenticated-review/cost replay, JSON/null
validation, current-secret changes and rollback/redaction.

`verify-native.mjs` uses **already installed local** `embedded-postgres`, `pg` and
TypeScript dependencies to create a disposable loopback server. It never downloads
or reads a production DB URL. Example:

```sh
TRACK_B_HARNESS=/tmp/track-b-harness \
TRACK_B_POSTGRES_RUNTIME=/tmp/agent-persistence-runtime \
node docs/data-production-integration/storage/verify-native.mjs
```

Native validation passed five assertion groups on embedded PostgreSQL runtime
18.6.0-beta.19 / pg 8.23.1, with eight distinct backend PIDs synchronized before
claim SQL, exactly one claim and one immutable completion winner, lost commit
acknowledgements, denied foreign completion, explicitly verified reconciliation,
immutable receipt/deletion guards, and a real server stop/start preserving
operation, cost, review and receipt records. Native cost/review rows are storage
fixtures; the PGlite suite separately invokes the actual cost capture and
authenticated review-ledger adapters with explicitly synthetic auth fixtures.
These fixtures do not represent real human review or production authorization.
The native verifier emits source and migration hashes for the executed artifacts.

Remaining live obligations: authorized migration application; least-privilege
server-only DB role; host job/tenant and human-session authorization; current
secret-policy source; a real authenticated receipt verifier; an authorized
idempotent measured-cost sink; human review intake; design review/freeze service
completion and producer/workflow integration. Unavailable or unknown evidence
must leave the production gate blocked. No live provider, network service, spend,
cloud migration, deployment or human review was performed by this workstream.
