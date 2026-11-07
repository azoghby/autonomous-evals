# Trusted Neon branch connection resolver

`packages/core/src/simulator/connection.ts` supplies `createNeonConnectionResolver(config) -> (owned: BranchOwnership) => Promise<string>`, directly compatible with `createBranchServices({service, findOwnedBranch, connectionString})`. Parent must add exports to `simulator/index.ts`; this change deliberately does not edit that file.

```ts
const connectionString = createNeonConnectionResolver({
  projectId: trustedProjectId,
  seedBranchId: trustedSeedBranchId,
  databaseName: trustedDatabaseName,
  roleName: trustedRoleName,
  apiKey: privateNeonApiKey,
  findOwnedBranch: durableOwnedBranchLookup,
});
const branches = createBranchServices({ service, findOwnedBranch: durableOwnedBranchLookup, connectionString });
```

Configuration is server-owned, explicit and captured at factory creation. Do not derive it or the ownership lookup from customer/model inputs. No environment variables are read. Keep the factory and returned credentials in private server code. Credentials are returned only after validation and are never logged or persisted by this resolver.

## Verified official API contract

Checked November 7, 2026 against official Neon documentation and Neon's published OpenAPI schema:

- [Retrieve branch details](https://neon.com/docs/reference/api/branches/get-project-branch): `GET /projects/{project_id}/branches/{branch_id}` returns `branch`, including identity, default/protected flags and current/pending state.
- [List branch endpoints](https://neon.com/docs/reference/api/branches/list-project-branch-endpoints): `GET /projects/{project_id}/branches/{branch_id}/endpoints` returns `endpoints`. A branch permits one read/write endpoint, with optional read-only endpoints.
- [Retrieve connection URI](https://neon.com/docs/reference/api/projects/get-connection-uri): `GET /projects/{project_id}/connection_uri`, with explicit `branch_id`, `endpoint_id`, `database_name`, `role_name`, `pooled=false`. Response is `{uri:string}`. Omitting the branch selects the project's default branch; this resolver never omits it.
- [Official OpenAPI schema](https://github.com/neondatabase/neon-api-python/blob/main/v2.json): `BranchState` describes init/ready/archived; `EndpointState` lists init/active/idle. Endpoint metadata includes id/project_id/branch_id/host/type/disabled/pending_state. These fields, rather than guessed operation status fields, drive readiness.
- [Neon on-demand activation](https://neon.com/blog/cold-starts-just-got-hot): idle compute activates on a connection. Therefore a ready branch with an enabled active **or idle** endpoint and no pending transition is connectable. This resolver does not open a SQL connection, wake compute, or prove SQL/migration readiness. Caller must bound the first SQL connection and handle cold starts.

## Ownership and URI guarantees

Only a `ready` durable ownership record with a recorded branch ID can proceed. The resolver validates job/project/parent/name/branch against an independent durable lookup before any HTTP request, and rechecks it before returning the URI. Names follow the existing `NeonBranchService` generated `eval-job-<UUID>` format. Seed branch IDs, changed records, missing records, and deletion/reconciliation states fail closed.

The fetched branch must match the recorded ID, configured project and seed parent, and recorded name. Both default/protected flags must explicitly be false. Every listed endpoint must belong to that same project/branch. A unique read/write endpoint must exist, have an enabled connectable state, no pending state, and a Neon hostname whose first label exactly equals its endpoint ID. No default URI or host fallback is used.

The returned direct PostgreSQL URI must match that endpoint hostname, configured database and role, contain a password, and use port 5432 or its default. TLS is required (`sslmode=require`, `verify-ca`, or `verify-full`). Only optional `channel_binding=require` is additionally accepted. Pooler hosts, fragments, duplicate parameters, libpq host/endpoint overrides, options, and unknown query keys are rejected. This intentionally conservative contract may need a reviewed update if Neon changes URI format or hostname suffixes. No credentials are reconstructed or guessed.

Independent HTTP observations and ledger rechecks cannot atomically prevent an external operator from changing a branch after verification. App code must serialize lifecycle operations against credential resolution/use and prevent concurrent cleanup/reassignment; production operators must preserve these ownership constraints.

## Errors, bounds and durable waiting

`NeonConnectionError` exposes a fixed safe `code`/message and `retryable` boolean, without causes or raw provider bodies. `branch_not_ready` means the branch/endpoint is initializing, archived, transitioning, disabled, lacks a writer, or Neon returned 423/429/503. The resolver makes no retries or sleeps. Workflow should persist a bounded attempt/deadline policy, sleep with backoff outside the step, then invoke again. Archived/disabled branches may require operator intervention; do not retry forever. Never classify ownership or malformed-response failures as readiness.

Network errors and timeouts have safe retryable codes. HTTP auth/not-found/other failures use `neon_connection_http_error` and require caller reconciliation. Malformed JSON/schema/URI/oversized responses use `neon_connection_invalid_response`. Ownership errors are `branch_not_owned` or `branch_ownership_mismatch`; configuration errors use `invalid_neon_connection_config`.

All remote requests are GET to the fixed `https://console.neon.tech/api/v2` origin, use bearer auth and `redirect:error`, and never expose error bodies. One invocation has a hard total 30 second deadline (including ledger lookups, headers and body reads); each response is streamed with a 1,000,000 byte cap. Trusted `timeoutMs`/`maxResponseBytes` can only lower these limits. Aborts cancel readers; even an injected fetch ignoring abort cannot keep the caller waiting. Injected `fetch` is a trusted testing seam, not a customer option.

## Parent / Track A wiring still required

Export the resolver/error/types from the simulator index. Supply private project/seed/database/role/key configuration and a committed durable ownership lookup consistent with `NeonBranchService`'s ledger. Wire the resolver as the adapter's `connectionString`. The existing branch service's `ready` ledger state records successful creation, not control-plane readiness; Workflow must handle the resolver's separate readiness result. Keep lifecycle operations serialized, protect/encrypt any stored URI, and never include it in progress/evidence/prompts/logs. Wire a bounded SQL connection and pinned transaction pool; apply simulator migrations to the seed using the separate authorized provisioning path. Maintain the existing cleanup schedule and reconciliation rules.

No live Neon API key was available. No resources were provisioned or changed. Verification uses injected fetch only, with synthetic credentials and boolean assertions that avoid printing credential values.

## Validation evidence

Used a separate temporary harness at `/tmp/ae-connection-check.DSrKrP`, copying current `simulator`/`targets` source and linking the existing `/tmp/track-b-harness/node_modules` dependencies. No repository harness/config files were edited. TypeScript 5.9.3 strict checking passed; Vitest 3.2.7 passed **167 tests across 8 files**, including **79 connection tests** and existing simulator/target regressions. `git diff --check` passed.

```sh
/tmp/ae-connection-check.DSrKrP/node_modules/.bin/tsc --project /tmp/ae-connection-check.DSrKrP/tsconfig.json
/tmp/ae-connection-check.DSrKrP/node_modules/.bin/vitest run --root /tmp/ae-connection-check.DSrKrP
```

Focused cases cover branch/project/parent/name/ledger mismatches, seed/default/protected branches, branch and endpoint transitions, foreign/ambiguous/missing endpoints, read-only siblings, direct URI branch binding and routing overrides, malformed schemas/JSON, provider/auth/redirect errors, capped streams, hung requests/bodies/lookups, retryability, and valid encoded database/role credentials. These are mocked control-plane tests, not live Neon readiness or SQL connectivity evidence.
