# Target transport and calendar simulator handoff

Implemented only `packages/core/src/targets/**`, `packages/core/src/simulator/**`, and this document. No root manifests, Track A files, agents, evals, or reporting were changed. Track A contracts read from `origin/track-a` (673873d); all exported types are standalone and structurally compatible where described below.

## Public entry points

`targets/index.ts` exports:

- `ChatCompletionsClient(config: {endpoint, model, bearer?}, transport?: JsonTransport)` with `complete(messages, tools?) -> Promise<AssistantMessage>` and `checkTarget() -> Promise<{connected:true}>`.
- `HttpsJsonTransport(options?)`, `TargetError` (safe code only), `isPublicAddress`, `resolvePublic`, `TargetGate`.
- `createTargetServices(transport?) -> {checkTarget(ctx, {url,model,apiKey?,systemPrompt?}): Promise<{ok,detail}>}` matches Track A's service. `platformTarget(endpoint)` creates a client. `url`/`endpoint` must be the **full Chat Completions URL**, e.g. `https://provider.example/v1/chat/completions`; no path is guessed or appended. Pass `endpoint.systemPrompt` to the runner's `systemPrompt` argument.

The connection check sends one user message with no tools, requests at most 16 completion tokens (normal requests cap output at 1,024 tokens), and disables storage. It can consume provider credits; callers must disclose this before invoking it. No calls were made to a live model while implementing this work. Requests have a hard 30-second deadline including DNS/body reading, 256,000-byte request and 1,000,000-byte response caps. Trusted options can lower these. A shared process-local gate admits at most two requests; overload returns `target_busy`, without hidden queuing/retries. Track A must also limit distributed Workflow dispatch if it needs a cross-process global limit.

The probe accepts a valid assistant envelope ending in `length`, even with no visible text, as connectivity-only evidence; it still rejects malformed envelopes and unsolicited tool calls. Actual evaluation continues to reject truncated output. Trusted target configuration may explicitly set `maxCompletionTokens` from 16 to 32,768 (default 1,024); there is no automatic cap increase or retry. Track A must communicate potential customer-provider credit consumption when choosing higher limits.

HTTPS only, port 443 only, no URL credentials/query/fragment, no redirects, no environment proxy or pooled connections. DNS returns all addresses; any non-public answer rejects the whole set. The selected public IP is supplied directly to `https.request`, eliminating a second lookup/rebinding window. TLS SNI, certificate identity verification, and Host retain the original hostname. IPv4 alternate encodings normalize through WHATWG URL before validation. Private, reserved, mapped IPv6, transition IPv6, multicast, link-local, documentation and non-global IPv6 ranges are refused. Conservative policy can reject uncommon legitimate endpoints. Limits/errors never contain credentials, URLs, raw provider error bodies, or DNS errors. Successful assistant content is returned as untrusted evidence, never logged by these services. Node runtime required; not Edge runtime.

`simulator/index.ts` exports:

- `CalendarSimulator(store).execute(scope, actorId, toolCall) -> Promise<ToolResult>`.
- `CalendarStore`: `create(scope, seed)`, atomic serialized `transact(scope, action)`, `snapshot(scope)`, idempotent `reset(scope)`. `scope = {jobId,runId,version}`. `create` refuses reuse; versions and reruns get fresh state. `MemoryCalendarStore` is an internal/test implementation.
- `PostgresCalendarStore(db: TransactionalDatabase)`. Inject `query<T>(sql, params?) -> Promise<{rows:T[]}>` and `transaction(fn)` using a **pinned connection** and real BEGIN/COMMIT/ROLLBACK. HTTP one-shot queries cannot implement this transaction interface. No Neon driver is required by this code. Actor identity is a trusted server input, never model arguments.
- `pooledCalendarDatabase(pool)` adapts a pg-style pool with `connect`, `query`, and client `release` into that transaction interface. It pins every transaction statement to one checked-out connection, rolls back failures, discards connections after ambiguous commits/failed rollbacks, and rejects use of an escaped transaction executor after completion. It never retries transaction callbacks. Track A supplies the configured pool and its lifecycle.
- `calendarSeed(failNextMutation?)`, `calendarTools` (OpenAI function schemas), `CalendarState` and related types.
- `calendarAcceptanceScenarios()` returns twelve explicitly internal reference fixtures covering booking, conflict, duplicates, cancellation, rescheduling, time zones, read-only permissions, dependency failure, repeated cancellation, listing, adjacent intervals, and invalid intervals. Each includes a fresh seed, reference tool calls/codes, and SQL expectations. These validate the simulator; they do not replace engineer-generated, investigator-reviewed customer suites or prove a model completed the prompts.
- `runCalendarScenario({simulator,target,scope,scenarioId,actorId,prompt,systemPrompt?,seed}) -> Promise<CalendarExecution>`. Up to six total target requests, eight validated tool calls per round. The secure target client supplies per-request time/concurrency bounds. Injected internal fixtures are trusted, and do not independently get transport deadlines. Execution retains transcript, tool results, final state, stop reason, and round count. A tool round at the limit is executed but execution is marked `round_limit`, not success.
- `gradeCalendarState(db,scope,checks) -> {passed,results}`: closed, runtime-validated parameterized SQL checks for counts, exact existing event fields, matching created events without generated IDs, overlaps and successful mutations. `stateExpectationSchema` is available for scenario validation; use it for Track A scenario `checks[].spec`. Empty or unknown checks are rejected. Pass a transaction-bound executor for an atomic multi-check snapshot if further mutation is possible.
- `gradeSuccessClaim(db,scope,claimedSuccess,requiredState)` compares an explicitly classified claim with SQL checks and exposes `falseSuccess`; claim extraction/classification remains the investigator's responsibility. Required state must describe the action in question, including identity/time fields when counts alone are insufficient.
- `reproduceCalendar(input,original)` returns an unchanged copy of original evidence plus execution under a new random run ID. Supply the original frozen seed/scenario; this works on a newly recreated branch after the old branch expires. `compareCalendar(a,b)` compares observed event state, normalizing generated IDs, and makes no significance claim. It requires matching scenario IDs; the caller must guarantee the same frozen scenario/seed and retain a suite hash externally.
- `internalCalendarFixture('buggy'|'fixed', call)`: deterministic, explicitly internal fixture. Buggy claims success after a tool failure; fixed reports the failure. No SDK/model calls, customers, revenue, or live verification are implied.

## Calendar behavior and SQL

Apply `simulator/migrations/001_calendar.sql` to the seed branch. It creates only `sim_*` tables with composite scope keys, constraints, cascade reset and an interval index. `calendarSeed()` supplies fresh per-run fixtures: Alice owns `personal`, Bob owns `restricted`, Alice has read access to Bob's calendar, and a team sync occupies 17:00–18:00 UTC on November 8. Avoid shared mutable fixture runs. Each scenario is a logical isolated run; each tool executes a short database transaction rather than holding a transaction open across network/model calls.

The run row is locked before reading/modifying state, so duplicate/conflict checks and writes serialize. The adapter rewrites a run's small state under that lock; it is designed for bounded hackathon scenarios, not a large production calendar. All simulator writers must use the adapter. It does not provide RLS for arbitrary database clients; database credentials stay server-side. Tool-call IDs are idempotency keys scoped to the run; reuse with different actor/name/arguments is rejected. Dependency failure is one-shot, durable and applies only after authorization/validation succeeds. Retrying the same call ID preserves the original failure.

Tools are `list_events`, `create_event`, `update_event`, `cancel_event`. Read permission permits listing, write permission permits mutation. Unknown/inaccessible objects give the same forbidden response. Unknown fields (including spoofed owner IDs), invalid intervals and malformed arguments are rejected. Times require explicit UTC ISO strings ending in Z, are normalized to milliseconds, and have a separately validated explicit zone (`UTC` or an Intl-recognized Area/Location IANA identifier). Local wall times and numeric offsets are refused: the target must resolve DST ambiguity before calling. Overlapping active events conflict, equal intervals are duplicates, adjacent intervals are permitted, cancelled events release their slot, and cancellation is idempotent. Owner/time/status fields can be graded directly in SQL.

## Neon lifecycle and contract adapter

`NeonBranchService(api, ledger, projectId, seedBranchId)` exports:

- `createJobBranch(jobId) -> Promise<BranchOwnership>`.
- `deleteJobBranch(jobId) -> Promise<{state:'absent'|'delete_requested'|'deleted'}>`.

`NeonHttpApi(apiKey)` uses the fixed official v2 origin. `NeonApi` is injectable for tests. The create body explicitly selects the configured seed parent and requests one read/write endpoint. Returned ownership excludes roles, connection URIs and credentials. A production `BranchLedger.withJobLock` must durably serialize a job and commit **each put before it resolves**. Persist `creating` before POST. No automatic repeated POST after ambiguous failure/crash; such records require operator reconciliation with the recorded random branch name. No name-only adoption or deletion is implemented. A successful response stores branch ID. Concurrent/repeated ready creation returns that owned branch.

Cleanup looks up only recorded ownership and verifies API ID/project/name/parent, rejects protected/default/seed branches, and never takes an arbitrary branch ID directly. Missing/deleted branches clean up idempotently. HTTP 200 DELETE means asynchronous deletion accepted; a later cleanup call confirms absence. No real branches were provisioned or deleted.

`createBranchServices({service,findOwnedBranch,connectionString})` supplies the exact Track A service shapes:

- `createJobBranch(jobId) -> {branchId,connectionString}` using an injected **trusted branch-specific URI resolver**.
- `deleteJobBranch(branchId) -> void` first resolves a durable owned record; arbitrary/unowned IDs are rejected. The core service re-verifies ownership before DELETE. The adapter throws `BranchCleanupPendingError` (`code: branch_cleanup_pending`) while deletion is only accepted, and resolves only after deletion is confirmed. Catch this typed error in Workflow, schedule a later observation, and do not mark cleanup complete; subsequent calls observe the branch without repeating an accepted DELETE.

**Track A integration still needed:** implement durable ledger locking/committed puts and owned-ID lookup; provide branch-scoped URI resolution and a pinned-transaction SQL driver; encrypt and protect connection strings; persist/export original evidence; provide frozen seed/hash metadata; map scenario state specs with `stateExpectationSchema`; schedule cleanup at 48h after delivery (credentials at 24h separately). The `void` delete result has no pending variant; the adapter now surfaces pending cleanup through the typed error above. Retain the ledger tombstone and retry/reconcile pending cleanup. The create contract cannot express `creating/reconciliation/operations pending`; callers must handle these explicit errors and await Neon readiness/connectivity before applying SQL. This implementation does not provision projects/seed branches, run migrations automatically, or expose a full Opus-owned `runSuite` implementation.

## Validation and reproduction

No repository package harness existed. All dependencies and generated files were installed/copied outside the checkout at `/tmp/track-b-harness`; no manifests or lockfiles were edited. Validated with Node **24.21.0**, TypeScript **5.9.3**, Zod **4.6.7**, ipaddr.js **2.5.0**, Vitest **3.2.7**, @types/node **22.20.5**, PGlite **0.5.15** (actual PostgreSQL **18.6**, WASM).

Runtime dependencies needed by Track A: `zod@^4.6.7`, `ipaddr.js@^2.5.0`, Node built-ins. Test dependencies: `vitest@3.2.7`, `typescript@5.9.3`, `@types/node@22.20.5`, `@electric-sql/pglite@0.5.15`.

Reproduce from the repo root (replace the temporary directory if needed):

```sh
mkdir -p /tmp/track-b-harness
npm install --prefix /tmp/track-b-harness --save-exact zod@4.6.7 ipaddr.js@2.5.0 vitest@3.2.7 typescript@5.9.3 @types/node@22.20.5 @electric-sql/pglite@0.5.15
cp -R packages/core/src/targets packages/core/src/simulator /tmp/track-b-harness/
cat > /tmp/track-b-harness/tsconfig.json <<'JSON'
{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","strict":true,"esModuleInterop":true,"skipLibCheck":true,"noEmit":true,"types":["node"]},"include":["targets/**/*.ts","simulator/**/*.ts"]}
JSON
cd /tmp/track-b-harness
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
```

**Result: strict TypeScript check passed; 72 tests in 3 files passed.**

Focused tests cover SSRF URL/address bypasses, mixed DNS answers, pinned HTTPS options and no re-resolution, redirect refusal, auth omission/redaction, response/request caps, DNS/socket deadlines and two-call admission, malformed completions, tool loop bounds, unauthorized mutation, simultaneous duplicates, conflicts, cancellations, updates, timezone/DST handling, version/reset isolation, rollback, real SQL field/count graders and false-success detection, preserved reproduction evidence, ambiguous Neon creates, ownership guards and idempotent asynchronous cleanup. HTTPS socket behavior is mocked; TLS identity/pinning options are asserted, not tested with a real provider socket. SQL executes on PGlite, not a live Neon cluster; cloud control-plane responses are mocked. No live spending, email, cloud mutation, credentials or production readiness claims.

### Parent integration verification

Independent review identified and parent regression tests fixed PostgreSQL-hostile NUL/lone-surrogate tool text. The boundary rejects unsafe call identifiers/raw arguments; decoded tool fields are validated before storage. Invalid target responses retain bounded JSON-escaped evidence, and unexpected tool-execution failures return a safe `simulator_error` stop with the partial transcript when state remains readable.

Neon create responses 423/503 now persist `retryable` with an attempt count and allow at most three caller-dispatched attempts. Timeouts/network failures remain ambiguous and require reconciliation. This follows the [Neon create-branch retry rules](https://api-docs.neon.tech/reference/createprojectbranch). Pending/ambiguous deletion is observed with GET until absent, without another DELETE; explicit 423/503 deletion responses permit a later retry. Track A should back off retryable responses and preserve the new ownership state/count in its durable ledger.

After integration, strict TypeScript and 100 tests passed across target, simulator, judge, monitoring, and pooled-transaction components using the repository's isolated harness (Vitest 5.1.0).

On November 7, the parent also exercised `HttpsJsonTransport` over a real connection to `https://postman-echo.com/post`, with a 10-second timeout and 16 KB response cap. A synthetic fixture payload was echoed correctly. No credentials were sent. This verifies the real DNS-pinned TLS/HTTP path against that public echo service; it is not a model completion, authorized customer evaluation, or Neon control-plane test. The mocked bypass/deadline tests remain necessary alongside this one successful connection.

The additional `targets/tls.test.ts` tests use real local Node HTTPS/TLS sockets and a fresh
one-day test certificate generated with OpenSSL (required on the test host). A test-only
request wrapper redirects the validated public destination to a loopback ephemeral port
and supplies that certificate as a trusted root. Production transport options and code
remain unchanged. The tests exercise original-host certificate identity, SNI/Host,
untrusted issuer rejection, streamed response caps, redirect/encoding rejection and total
deadline abort. They assert the original pinned public destination before substitution;
they do not prove real network routing to that public address or DNS rebinding resistance
by themselves. Test keys and server state are temporary and removed afterward.

Official references checked during implementation: [Node HTTPS request options](https://nodejs.org/api/https.html), [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [ipaddr.js APIs](https://github.com/whitequark/ipaddr.js), [Zod APIs](https://zod.dev/api), [PGlite query/transactions](https://pglite.dev/docs/api), [Neon create branch](https://neon.com/docs/reference/api/branches/create-project-branch), [Neon delete branch](https://neon.com/docs/reference/api/branches/delete-project-branch).

## Text evaluation bridge

`createTextTarget(endpoint, transport?)` returns a structural `TextTargetPort` with `send({scenarioId, runId, systemPrompt, userMessage})`. It uses the secure Chat Completions client by default, keeps endpoint credentials inside the adapter, returns complete text plus elapsed milliseconds, and maps failures to safe codes without provider error bodies. Truncated output and unsolicited tool calls are failures. The frozen request's system prompt is authoritative (including `null`); endpoint defaults do not override it. Scenario/run identifiers remain local evidence metadata and are not sent to the provider. Target-provider monetary usage remains unknown; latency is not a cost estimate.

`createBranchServices` also exports `getJobBranchConnection(branchId) -> Promise<string>` for Track A's optional private service contract. It requires a matching durable owned record in `ready` state, reuses the configured trusted connection resolver, validates the PostgreSQL URI scheme, and does not provision a new branch. Track A must authorize the customer's job before calling it; branch ownership alone is not customer authentication. Call inside server Workflow steps and never persist or return the secret as an artifact or public step result.
