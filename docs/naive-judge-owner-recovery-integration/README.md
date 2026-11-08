# Judge owner recovery candidate

Private app capability and route candidate against the implemented optional judge attempt protocol (35fbcab). This directory changes no active app, core source, migration, deployment or database. It supplies neither evaluation publication authority nor a provider dispatch interface.

The atomic keyed `recordSettledCost` sink is already adopted source. The separate **operator10 candidate remains pending owner approval**, including its private v1 `/proxy-billing/reconcile` route; this artifact does not depend on adopting that route. Existing v1 route candidate request/response semantics remain unchanged. This candidate adds a separate `/api/operator/jobs/[id]/judge-recovery` route.

Copy the three files under `source/apps/web/src` only after owner review and sidecar activation acceptance. The production adapter uses the existing canonical database, fresh `requireOperator`, immutable operation metadata, and keyed owner cost sink. SDK access is enclosed behind `audit.call(requestId)`; there is no send/create/provider request method on the capability.

Requests are strict JSON, streamed and capped at 4096 bytes, and all handler responses carry private no-store, Cookie Vary and nosniff headers:

```json
{"action":"accounting","cursor":"optional 64-character checkpoint digest"}
```

```json
{"action":"recoverUndispatched","operationId":"retained-operation-id","attempt":1,"reason":"Operator verified this exact attempt never dispatched"}
```

Omit `cursor` on the first accounting request. Each page selects at most 26 SQL rows and processes 25; use `nextCursor` while `remaining` is true. SQL checkpoint IDs provide one stable cursor across v1 and v2 intents. Malformed or unknown identities count as pending and retain their fences. The reconciliation core independently verifies exact v2 intent, attempt checkpoint, reservation, provider request and measured trace. This candidate additionally requires the retained SQL attempt to be dispatched before accounting.

`drainJudgeAccounting(jobId, deps, cursor?)` is independently callable **before** paid evaluator authorization/construction. Its production dependencies do not read evaluation entitlement or construct paid services: cancelled jobs and revoked plans can settle already measured cost. The shared paid factory must call this helper before its authorization gate; the factory integration is a separate owner patch. Bound the number of pages per invocation and schedule continuation when `remaining` is true. An operator request/session is required by this adapter; a background accounting worker needs a separately reviewed trusted authorization adapter rather than weakening this check.

Each item rechecks the current operator identity and canonical job/customer/environment/package. V2 policy, period, job cap, judge cap and additional scopes come exclusively from immutable `naive_proxy_dispatch.operations.policy`, never the request. Settlement touches the original reservation, preserving all its additional scopes without reserving again. Legacy v1 uses the unchanged settlement-only recovery policy.

Undispatched recovery passes the exact requested attempt and SQL digest to the core store. Inside its locked SQL transaction the callback rechecks current operator identity, current job ownership/environment under a job row `FOR SHARE` lock held through commit, and exact immutable SQL policy. It supplies an operator actor and reason; the core records the audit atomically with abandonment and zero settlement. Replays reauthorize and retain the original audit. Dispatched or unknown attempts cannot be reopened. Neither successful recovery nor accounting creates another attempt or provider request; subsequent evaluation requires its independent paid authorization and `prepare`.

Remaining activation gates: optional sidecar staging application/replay and two-connection contention; owner approval of this new app source; shared factory integration review; real hosted Workflow hold behavior and provider audit/rollback acceptance. No live calls were made for this artifact.

Local checks:

```sh
npx tsc -p docs/naive-judge-owner-recovery-integration --noEmit
npx vitest run --config docs/naive-judge-owner-recovery-integration/vitest.config.ts
npx vitest run --config docs/naive-judge-owner-recovery-integration/vitest.config.ts
```

Eight migration-backed PGlite tests pass: mixed v1/v2 bounded discovery, revoked legacy/evaluator adapter independence, measured v2 replay, immutable additional scopes, exact abandonment/audit replay, dispatched/unknown fences, operator rotation rollback, canonical environment changes, strict bodies/private responses and conflicting keyed cost retention. These are single-connection SQL tests with audit fixtures, not live PostgreSQL contention/provider/Workflow acceptance.

Parent independent review found and corrected a canonical job identity race by locking the job row during recovery. Local PGlite tests verify that the locking read is used and mutation rollback remains correct; they do not prove two-connection PostgreSQL blocking. Authentication is a fresh point-in-time session/allowlist check, not transactionally locked session revocation.

`manifest.json` pins the new-file postimages and `owner.patch` against source checkpoint `c24e341`. Parent verified patch applicability and independently repeated the documented SQL tests and types. This is a focused candidate check, not a complete composed application build.
