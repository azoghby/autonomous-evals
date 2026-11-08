# Cross-service measured costs

Base/source: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`. Contracts are absent from this worktree; the scoped runner stages the already-local `origin/track-a` contract tree (`8634ceb30f3d98de7ec24b240a4f7549dce80033`). No fetch/install/network calls.

## Execute / integrate

```sh
TRACK_B_REVIEW_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules node tests/track-b/cross-service-release/costs/run.mjs
```

Use any existing compatible dependency directory via `TRACK_B_REVIEW_NODE_MODULES`; optional `TRACK_B_CONTRACT_REF` selects a local contract revision. The runner stages production sources/migrations, runs strict TypeScript with no emit, then only this suite. See `results.txt` for exact output.

`cases.ts` exports async cases for a combined lead check: `failedServicesRetainMeasuredCosts(path)`, `pendingThenSettledCosts(path)`, `lostCostAcknowledgement(path)`, `blockedOperatorCosts(path, stopReason)`, and `reportSnapshotCharacterization(path)`. Supply a fresh empty temp directory per invocation; callers remove it afterward. The operator case takes `budget_paused` or `awaiting_input`. Preserve repository-relative layout when staging. Six tests: five acceptance, one explicitly labeled current-defect characterization. A passing characterization does **not** establish immutable report snapshots.

## Acceptance evidence

- Actual `AgentSessionService`, `createTrackBServices`, `PostgresAgentTaskStore`, `PostgresBudgetLedger`, `PostgresTextCheckpointStore`, and `renderReport`. Disk-backed PGlite executes the original production migrations. Cases close/reopen storage and reconstruct adapters/services.
- Failed qualification plus schema-failed report operator retain 125001 + 250002 micro-USD. Fallback Markdown/HTML show $0.38, with unknown hosting costs retained. Replay creates/polls no sessions and writes no duplicate cost rows; job-scoped reads exclude another job.
- Pending qualification with scripted interim usage reserves budget but emits no cost, leaves consumed/settled SQL fields null, and resumes the same session after reopen. Terminal 190003 micro-USD settles once and replays once. This validates terminal accounting, not durable interim usage tracking.
- Lost cost-write acknowledgment: the application sink commits before throwing; replay after reopen emits the same session idempotency key, preserving one row and one settlement with no provider redispatch.
- Budget-paused report operator records 310007 micro-USD before typed blocking. Needs-input report operator records the same amount before the current fallback behavior. Both replay without session calls or duplicate rows.

## Current defect: mutable JSON report cost snapshot

Minimal repro: read a measured cost list from durable SQL; call `renderReport({ ..., costs })`; mutate `costs[0].microUsd`. `report.json.costs.entries[0].microUsd` changes to the mutation, while `knownMicroUsd`, Markdown and HTML still reflect the original amount. `reportSnapshotCharacterization` asserts the observed inconsistency (125001 total versus 999999 entry). A separately read SQL list is detached and SQL remains 125001, isolating the alias to `packages/core/src/reporting/render.ts` (`entries: input.costs ?? []`). Minimal production fix direction: defensively snapshot cost rows at render entry. Outside test ownership; no production fix made.

## Limits

Provider behavior is a deterministic local port script, not live SDK validation. PGlite is single-session PostgreSQL-compatible execution, not external PostgreSQL contention/crash testing. The application cost sink/list callback is test-owned support implemented with the **real** durable checkpoint adapter; no production cost repository exists in the owned Track B source tree. Exactly-once cost storage depends on the caller honoring the documented atomic session idempotency contract. Reopen is in-process disk persistence, not OS process termination. No broad fixtures, deployed service, cloud, spending, secrets, outreach, push or PR operations.
