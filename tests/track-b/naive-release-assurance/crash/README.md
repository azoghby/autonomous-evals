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
node tests/track-b/naive-release-assurance/crash/run-local.mjs '/Users/alexzoghby/Documents/ChatGPT/YC Hackathon 2/tests/track-b/node_modules' '/Users/alexzoghby/.t3/worktrees/simulization/t3-52d1553b/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/cli.mjs'
```

Pass equivalent existing local dependency paths on another machine. The helper
does not discover dependencies, install packages, load environment files, or read credentials.

## Acceptance map

These are local acceptance notes, not live provider acceptance or a mapping to an
unseen parent acceptance document. Test titles explicitly separate acceptance from
defect characterization.

| Local requirement | Executable coverage |
| --- | --- |
| CRASH-01: provider created, acknowledgement lost | Fake's `createdAnyway` failure; SQL remains ambiguous/unsettled; lookup adopts one session without another create |
| CRASH-02: adoption transaction interrupted | Rollback and post-commit lost ack; SQL state checked, active create lease respected, expired lease recovers by lookup |
| CRASH-03: settlement transaction interrupted | Rollback and post-commit lost ack; reservation is held or settled as appropriate, retry settles once |
| CRASH-04: terminal task CAS interrupted | Rollback after settlement and post-commit lost ack; retry polls only when needed and reuses the durable terminal row otherwise |
| CRASH-05: external cost delivery interrupted | Failure before sink commit and lost ack after sink commit; same measured payload redelivered, SQL sink contains one keyed cost |
| CRASH-06: competing finalizers | Provider barrier makes two runtime instances read the same created revision; real SQL CAS advances terminal revision once; both callers deliver the same cost |
| CRASH-07: settlement, task and delivered cost stay consistent after recovery | **Not accepted generally**: D1 characterizes inconsistent amounts when the provider revises terminal usage between settlement and retry |

The six SQL-boundary cases verify the injected fault actually fired, intermediate
task/reservation/cost rows, recovered output and usage, provider create count,
lookup/poll behavior, and repeated terminal replay. Cost sinks must implement
keyed idempotency; the test sink persists by `naive:<sessionId>` and rejects a
changed payload under that key. This is an explicit sink contract, not proof that
an arbitrary application sink is safe.

## D1: out-of-scope accounting consistency defect

Minimal executable repro: the test titled `CHARACTERIZATION D1`.

1. Run a task whose provider snapshot reports 12,345 micro-USD.
2. Let production settlement commit, then force rollback of the terminal task CAS.
   SQL now has settlement 12,345 and task state `created`.
3. Change only the fake provider's terminal snapshot to 23,456 micro-USD.
4. Recreate the runtime and rerun the identical task.
5. Runtime completes; reservation still says 12,345, but the durable task and
   external cost both say 23,456. No second provider create occurs.

Cause: `packages/core/src/agents/postgres-ports.ts` returns the first settled amount
on repeated settlement (around line 148). `session-service.ts` ignores that result
and persists the latest polled usage after `ledger.settle` (around lines 511–519).
Potential production resolution belongs to its owner: reconcile or reject changed
usage before persisting/delivering a different amount, with an explicit policy for
revised provider usage. Production was not edited. A passing characterization is
evidence of the defect, not a release acceptance pass for accounting consistency.

## Limits

- Faults are deterministic port-level interruption simulations, not OS process kills,
  disk/power failure, or tests of PostgreSQL network failover.
- Fresh runtime instances share the surviving SQL database and fake provider; the
  manual clock handles lease expiry without wall-clock sleeps.
- PGlite executes the actual PostgreSQL SQL and transactions, but does not establish
  external PostgreSQL multi-connection isolation, advisory locking, or deployment behavior.
- Provider deduplication/lookup semantics are the established fake's assumptions.
  No SDK, provider version, real billing, or mutable terminal-usage guarantee is verified.
- Successful stable-usage recovery and the revised-usage counterexample are both
  represented. The suite does not claim exhaustive crash points or arbitrary sink safety.
