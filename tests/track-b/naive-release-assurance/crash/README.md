# Crash / lost-ack release assurance

Base: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`. Only this `crash/` directory is owned.
ECC disabled. Tests use `node:test`, the production `createPostgresAgentRuntime`,
`AgentSessionService`, SQL task store and budget ledger, the actual persistence
migration, established `FakeNaive` / `ManualClock`, and embedded PostgreSQL (PGlite).
There are no provider, cloud, network, secret, spend, deployment, or outreach operations.

## Run

With normal local dependency resolution available:

```sh
tests/track-b/node_modules/.bin/tsx --test tests/track-b/naive-release-assurance/crash/*.test.ts
```

This worktree had no `node_modules`; tsx is also absent from the base Track B
package manifest. No install or manifest modification was performed. The offline
helper stages unchanged production sources and the test under the owned directory,
links existing installed dependencies, invokes the above tsx test command (with the
single expanded test filename), then removes the stage. Exact command used here:

```sh
node tests/track-b/naive-release-assurance/crash/run-local.mjs /tmp/autonomous-evals-checks.m10du4/node_modules /tmp/trackb-harness/node_modules/.bin/tsx
```

Pass equivalent existing local dependency paths on another machine. The helper
does not discover dependencies, install packages, load environment files, or read credentials.

Current scoped result: **13 passed, 0 failed/skipped/cancelled/todo** (7,328.018 ms).
Strict no-emit TypeScript compilation of the crash and version roots and imports passed.

## Acceptance map

These are local acceptance notes, not live provider acceptance or a mapping to an
unseen parent acceptance document. D1 cases are regressions for the repaired accounting boundary.

| Local requirement | Executable coverage |
| --- | --- |
| CRASH-01: provider created, acknowledgement lost | Fake's `createdAnyway` failure; SQL remains ambiguous/unsettled; lookup adopts one session without another create |
| CRASH-02: adoption transaction interrupted | Rollback and post-commit lost ack; SQL state checked, active create lease respected, expired lease recovers by lookup |
| CRASH-03: settlement transaction interrupted | Rollback and post-commit lost ack; reservation is held or settled as appropriate, retry settles once |
| CRASH-04: terminal task CAS interrupted | Rollback after settlement and post-commit lost ack; retry polls only when needed and reuses the durable terminal row otherwise |
| CRASH-05: external cost delivery interrupted | Failure before sink commit and lost ack after sink commit; same measured payload redelivered, SQL sink contains one keyed cost |
| CRASH-06: competing finalizers | Provider barrier makes two runtime instances read the same created revision; real SQL CAS advances terminal revision once; both callers deliver the same cost |
| CRASH-07: settlement, task and delivered cost stay consistent after recovery | D1 regressions retain first-writer settlement in task/cost, refuse output and require reconciliation after revised usage, including lost acknowledgement and competing finalizers |

The six SQL-boundary cases verify the injected fault actually fired, intermediate
task/reservation/cost rows, recovered output and usage, provider create count,
lookup/poll behavior, and repeated terminal replay. Cost sinks must implement
keyed idempotency; the test sink persists by `naive:<sessionId>` and rejects a
changed payload under that key. This is an explicit sink contract, not proof that
an arbitrary application sink is safe.

## D1 regression policy

The first successful ledger settlement remains authoritative for the task and delivered cost.
When provider terminal usage changes after a terminal CAS rollback or a lost settlement
acknowledgement, recovery returns `needs_operator` / `settlement_usage_conflict`, persists
12,345 micro-USD consistently and refuses the revised output. Replaying the resulting task
performs no provider I/O and redelivers the same cost identity. An additional deterministic
race holds the first settlement acknowledgement after commit while a revised-usage finalizer
wins terminal CAS; the stale first finalizer rereads the same operator outcome.

This proves local accounting consistency, not automatic provider-bill reconciliation.
A human policy must resolve the newly observed 23,456 amount without silently rewriting an
immutable first settlement or issuing a second automatic charge.

## Limits

- Faults are deterministic port-level interruption simulations, not OS process kills,
  disk/power failure, or tests of PostgreSQL network failover.
- Fresh runtime instances share the surviving SQL database and fake provider; the
  manual clock handles lease expiry without wall-clock sleeps.
- PGlite executes the actual PostgreSQL SQL and transactions, but does not establish
  external PostgreSQL multi-connection isolation, advisory locking, or deployment behavior.
- Provider deduplication/lookup semantics are the established fake's assumptions.
  No SDK, provider version, real billing, or mutable terminal-usage guarantee is verified.
- Successful stable-usage recovery and revised-usage refusal regressions are both
  represented. The suite does not claim exhaustive crash points or arbitrary sink safety.
