# Measured-cost release assurance

Base: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`. Offline fixtures only; no SDK transport, provider, cloud, or external SQL connections.

## Run

With the parent's local dependencies provisioned:

```sh
tests/track-b/node_modules/.bin/tsx --test tests/track-b/naive-release-assurance/cost/*.test.ts
```

The tests use `node:test`, not Vitest, and import the actual repository implementation directly. Dependencies are `tsx`, `zod`, and `@electric-sql/pglite`. The pre-existing `run-checks.mjs` stages a different Vitest suite; it does not discover this directory. Use the explicit command above for these discoverable `*.test.ts` files.

This checkout has no `tests/track-b/node_modules`. The local verification used installed caches without installing or fetching anything:

```sh
NODE_PATH=/tmp/autonomous-evals-checks.m10du4/node_modules /tmp/trackb-harness/node_modules/.bin/tsx --test tests/track-b/naive-release-assurance/cost/*.test.ts
```

For that run only, ignored dependency links under this owned directory's `node_modules` resolve `zod` and `@electric-sql/pglite` from `/tmp/autonomous-evals-checks.m10du4/node_modules`. These links are not committed and are not a dependency on those paths for normal use with the parent's provisioned dependencies.

Verification result: exit 0; 12 tests passed, 0 failed, 0 skipped (11 acceptance checks with a fixture app sink, 1 boundary characterization); duration 97,299 ms. `git diff --check` also passed.

## Acceptance map

| Requirement | Executable evidence | Scope |
| --- | --- | --- |
| Stable measured entry and `naive:<sessionId>` delivery key | Same task replay, exact entry/key equality, SQL row count and total | Actual runtime and SQL persistence; contract fixture sink |
| Failed sink before durable commit | Caller rejects, app has zero rows, retry delivers original entry | Actual runtime replays terminal SQL task without a new create, poll, or reservation |
| Lost acknowledgement after durable commit | Caller rejects, app already has one row, retry keeps one row and unchanged total | Actual runtime plus fixture app SQL uniqueness/transaction |
| Same key with changed amount | Mutate terminal measured amount through actual `PostgresAgentTaskStore.compareAndSet`; retry reaches same sink key and throws conflict | Conflicting app charge remains unchanged; rejection is supplied by fixture sink |
| Changed request is distinct from changed measured amount | Changed message yields `task_input_changed`, with no extra sink call | Actual runtime guard |
| Charges survive unsuccessful outcomes | Schema failure, budget pause, provider failure, operator-needed outcome | Actual runtime; one measured SQL cost per session after replay |
| Zero versus unknown usage | Zero persists a measured row; undefined usage delivers nothing and retains unsettled reservation | Actual runtime and production SQL budget ledger |
| Application must enforce immutable cost identity | `CHARACTERIZATION` test accepts two different amounts under the same key with a permissive sink | Limitation evidence, **not** end-to-end release acceptance |

## Out-of-scope finding / minimal reproduction

The base contains `AgentCostSink` as an injected interface, but no application/platform/contracts implementation. `createPostgresAgentRuntime` delegates idempotency to that interface. Its production budget ledger settlement does not supply application charge uniqueness.

Minimal local reproduction is the `CHARACTERIZATION` test: complete one task for 12,345 micro-USD; use the public SQL task-store CAS port to change `consumedMicroUsd` to 99,999; reconstruct the runtime with a permissive sink; replay the same spec. The runtime returns `completed` and forwards the same `naive:<sessionId>` key with the new amount, while the reservation remains settled at 12,345. The injection simulates stored-data drift; this does not show a normal provider response can mutate an already completed task. No production fix is included or implied: the runtime documents the sink's conflict-rejection responsibility.

Parent acceptance remains open until the real application's durable sink is tested for duplicate replay and same-key amount/identity conflicts. The strict SQL sink here is explicitly test-owned and must not be treated as the missing application implementation. Track A contract mapping (`toContractCost` / `ServiceContext.recordCost`) is not exercised: its runtime contract imports are absent at this base. SQL executes in PGlite using the production agent migration and ports; no claim is made about Neon, pooled PostgreSQL concurrency, process restart/disk recovery, or live Naive billing. Reconstruction is of runtime/store/ledger objects against the same local SQL database.
