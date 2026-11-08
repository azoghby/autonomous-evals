# sandbox/runtime

Implements `SandboxRuntime` / `SandboxRun` from `../spec.ts` on Neon (plan §6, §12, §13).

```ts
import { createNeonSandboxRuntime, createGatewaySimulator } from "@ae/core/sandbox/runtime/index";
const runtime = createNeonSandboxRuntime({ simulate: createGatewaySimulator({ ctx }) });
const { worldId } = await runtime.prepare(env, jobId);          // golden branch + `world` DB
const run = await runtime.startRun(worldId, env, scenario, 0);  // trial_<hash> TEMPLATE world
await run.callTool("refund_order", { order_id: "ord_1", amount_cents: 100 });
const diff = await run.diff(); await run.dispose(); await runtime.teardown(worldId);
```

## Lifecycle
- **prepare**: creates branch `sbx-<job>-<rand>` off `parentBranchId` (or env `NEON_SANDBOX_PARENT_BRANCH_ID`, else the project's default branch) with `expires_at` = now + 24 h. It then runs `CREATE DATABASE world`, the preamble, the frozen clock, `state.ddl` and `state.seedSql`. Finally it runs `ALTER DATABASE world ALLOW_CONNECTIONS false IS_TEMPLATE true`. Without that last step, Neon background workers attach to the new DB and `TEMPLATE` copies fail with 55006.
- **startRun** (default tier `template`): runs `CREATE DATABASE trial_<16hex> TEMPLATE world` over a direct connection. Admin statements are serialized per world. It then applies `scenario.fixtureSql` and snapshots the baseline.
- **branch_pool tier** (`tier: "branch_pool"`, off by default): uses up to `poolSize` leaf branches off the job branch. A used leaf is reset with `POST /branches/{leaf}/restore {source_branch_id: job}`. Pool state lives in-process.
- **dispose**: `DROP DATABASE … WITH (FORCE)`. **teardown**: deletes the pool leaves, then the job branch.
- **Neon API**: mutating calls are serialized per project and wait for their operations to finish. 423 and 503 responses are retried with exponential backoff and jitter.
- **worldId**: `neon-world:<branchId>`. It is self-describing, so another process can start runs on the same world.
- **Admin connections**: these go to the always-present `postgres` database.

## Tools (`SandboxRun.callTool`, never throws)
1. Unknown tool → `unknown_tool`. Arguments must be an object (a JSON string is accepted) that is valid against `inputSchema` (in-house validator in `json-schema.ts`, since ajv is not a core dependency) → otherwise `invalid_arguments: …`.
2. Faults are counted per tool (`onCall`, 1-based):
   - `http_500`, `timeout` and `rate_limited` return an error **without executing** the tool.
   - `empty_result`, `stale_data` (the previous result for identical args) and `injected_instruction` (payload added as `notes` on the result or its last row) **execute normally**, so writes persist. Only what the agent sees is changed.
3. **`sql` bindings**: `:name` params compile to `$n`. Values are never interpolated, objects become JSON, and a missing param binds as null. All statements run in one transaction with `statement_timeout` 5 s and roll back on error. `resultShape` is one of:
   - `rows`
   - `row` (no row → `not_found`)
   - `count` → `{count}`
   - `none` → `{ok:true}`

   Statements, DDL, seed and fixtures all pass `assertSafeScript`, which rejects database, role and extension DDL, `COPY`, `dblink`, `pg_terminate_backend`, and so on.
4. **`simulated` bindings**: the injected `simulate(tool, args, snapshot)` receives up to 50 rows per `readsTables` table. Output is validated against `outputSchema`. When `recordsOutbox` is set, `sideEffects` (or `{result}`) are inserted into `sandbox_outbox`.
5. **`passthrough`** → `passthrough_not_supported` (v0).

## Frozen clock
`sandbox_clock(frozen_now)` plus `sandbox_now()` are installed before customer DDL. DDL defaults, seeds, fixtures and tool SQL must use `sandbox_now()`, never `now()`.

## Grader surface (`run.query`, SELECT/WITH only, `BEGIN READ ONLY`, 5 s timeout, ≤5000 rows)
The diff is refreshed lazily before `query()` and `diff()` whenever a SQL tool has run since the last refresh.

| object | shape |
|---|---|
| `sandbox_diff` | `table_name text, pk jsonb, change text ('inserted'\|'updated'\|'deleted'), before jsonb, after jsonb` (one row per changed row) |
| `sandbox_diff_summary` | `table_name, inserted, updated, deleted` |
| `sandbox_outbox` | `id, tool, args jsonb, payload jsonb, created_at` |
| `sandbox_baseline` | `table_name, pk, row_hash, row_data`: the state after fixtures, before the agent acts |

- **Coverage**: every non-`sandbox_*` table in every user schema is diffed. A table outside `public` is named `schema.table`.
- **Keys**: rows are keyed by primary key. A table without a PK is keyed by row hash plus an occurrence number.
- **No-op updates**: an UPDATE that leaves a row identical is not a change.
- **`diff()` output**: lists only changed tables, each with a sample of 5 rows `{change, pk, before, after}`.

Example expected-change predicate:
`SELECT count(*) = 1 AS ok FROM sandbox_diff WHERE table_name = 'refunds' AND change = 'inserted' AND (after->>'amount_cents')::int = 4720`.

## Tests
- `npx vitest run packages/core/src/sandbox/runtime`: unit tests using PGlite and fakes.
- `SANDBOX_LIVE=1 npx vitest run packages/core/src/sandbox/runtime/runtime.live.test.ts`: real Neon (`.env`). Loads `data/envs/acme-support/{schema,seed}.sql` into schema `acme` when present, runs isolated trials, and verifies no leftover trial DBs or branch.
