# Reservation release assurance

Base inspected: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`.
Only this directory is owned. No production files or dependency manifests were changed.

## Run

From the repository root, with the existing Track B dependencies and `tsx` available:

```sh
tests/track-b/node_modules/.bin/tsx --test tests/track-b/naive-release-assurance/reservations/*.test.ts
```

Native PostgreSQL `initdb` and `pg_ctl` must be installed. Set `RESERVATIONS_PG_BIN` to their directory, or put them on PATH. For this machine the helper also recognizes the already installed binaries in `/tmp/agent-persistence-runtime/node_modules/@embedded-postgres/darwin-arm64/native/bin`. Missing native binaries fail setup explicitly; the suite does not silently substitute PGlite or skip concurrency proof.

The checkout initially had no node_modules or tsx. Validation reused `/tmp/autonomous-evals-checks.m10du4/node_modules` for existing dependencies and populated `/tmp/reservations-test-tools` from cached `tsx@4.23.15` using `npm install --offline --ignore-scripts --no-audit --no-fund --prefix /tmp/reservations-test-tools tsx@4.23.15`. Temporary root and Track B node_modules symlinks were used for module/runner resolution and removed afterward. No package registry or provider requests were made. The tracked suite needs normal local dependency resolution for `pg`, `zod`, and the tsx runner; it does not install anything itself.

Exact final command above: exit 0, 13 tests passed, 0 failed, 0 skipped, 0 todo. Full captured output: `results.txt`. PostgreSQL 18.6 on aarch64 Darwin provided the native multi-session proof; PostgreSQL proof is available for this run.

## Acceptance map

| Requirement | Executable evidence |
| --- | --- |
| Independent SQL sessions | Four distinct backend PIDs; separate pg Clients and pinned READ COMMITTED transactions; TCP disabled |
| Simultaneous role, job, combined limits | Three scope-contention tests hold an observer row lock, require both contenders to reach actual PostgreSQL Lock waits, then release it; exactly one 60/100 reservation admitted |
| Duplicate concurrent identity | Same-ID contenders block on scope/reservation locks; exactly one persisted reservation, one replay, reversed caller scope order replays |
| Immutable caps | Changed role and job caps, both higher and lower, fail after settlement; transaction rollback removes inserted reservation and new scope |
| Immutable identity / refusals | Changed amount/job/scope rejected; original denial remains denied after release; new identity can use capacity |
| Overage | Concurrent settlement persists the first full measured amount (150 or 200 vs reserve 60), both role and job block new work; replay cannot reduce spend |
| Boundary accounting | Invalid usage cannot settle; measured zero releases both limits; exact-cap acceptance, zero cap and one-micro-USD excess refusal |
| Real runtime dispatch | Two runtimes backed by independent SQL sessions admit one fake-provider dispatch while its reservation is unsettled |
| Runtime accounting and reconciliation | Two explicitly labeled CHARACTERIZATION cases below; excluded from acceptance claims about escalation or automated recovery |

11 tests are labeled ACCEPTANCE, 2 CHARACTERIZATION. The suite imports the production `PostgresBudgetLedger`, `createPostgresAgentRuntime`, exact persistence migration, and established `FakeNaive`; it does not reimplement SQL admission or use an in-memory budget ledger. The runtime cost sink is an idempotent Map fixture, not proof of a durable application cost sink.

## Characterized limits / minimal repro for parent

These are observed behaviors requiring a parent policy decision, not acceptance of a stronger release requirement. No out-of-scope fixes were made.

1. **Overage does not itself escalate.** Run a task with reservation 60,000 and job cap 100,000; fake terminal usage 150,000 plus valid output returns `completed`. SQL and cost delivery preserve 150,000, and the next task is budget-exhausted. If release policy requires an overage operator alert or non-completed outcome, production runtime needs a separate fix. The test pins current behavior only.
2. **Corrected usage does not automatically reconcile a terminal operator task.** Return NaN terminal usage; runtime returns `needs_operator / invalid_session_usage`, leaves settlement NULL and delivers no cost. Correct the fake session usage to 10,000 and rerun the same task from another SQL session: it stays needs_operator without another provider poll. Explicit ledger settlement releases capacity but does not resume that task or deliver its original measured cost. A new task can dispatch afterward. If automated recovery or an operator recovery API is required, that is still unproven/out of scope. The test's new dispatch also receives invalid usage from the fake and consequently needs operator attention; this is intentional.

Caps and settlement immutability are proved through the production ledger API, not SQL permissions or database triggers against privileged direct updates. Concurrent first-settlement behavior is first-writer-wins even if the replay supplies a different amount; later corrections cannot be expressed via `settle`.

No live provider, cloud, external network, secrets, spend, outreach, deployment, push, or PR. This is local native SQL plus fake-provider proof, not hosted PostgreSQL, SDK compatibility, crash/restart durability, application billing delivery, or operator UI acceptance. Each run creates and tears down a private Unix-socket PostgreSQL cluster. No external database URL is accepted. Production and other teams' files remain read-only.
