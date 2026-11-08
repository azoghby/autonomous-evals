# Track B Naive release assurance

Production inspected at `6ff8a0642fc14dfd23842456d124a4b84f5e040a`.
Exactly four Codex Sol gpt-6.1-sol high children worked in separate T3 worktrees;
the fifth agent integrated their disjoint test directories and added the combined
strict runner. No recursive delegation, ECC, production edits, provider/API calls,
cloud requests, secret access, spending, deployment, push or PR.

## Reproduce the combined scoped check

From the repository root:

```sh
node tests/track-b/naive-release-assurance/run.mjs /tmp/autonomous-evals-checks.m10du4/node_modules /tmp/trackb-harness/node_modules
```

The positional arguments are existing local dependency directories, searched in
order. With normal local dependencies (including tsx), omit them. This checkout
has no Track B node_modules and its manifest does not declare tsx. The runner
installs nothing, stages a private source copy, resolves installed dependencies,
requires all four groups, performs strict no-emit TypeScript checking of the
four test entrypoints and their imports, and executes only those four files with
Node test concurrency 1. It removes staging afterward. Native PostgreSQL binaries
must exist: set `RESERVATIONS_PG_BIN`, use PATH, or use the already installed
embedded PostgreSQL binaries recognized by the local helper. Missing dependencies
or PostgreSQL fail explicitly rather than skip tests or substitute concurrency.

The first combined invocation failed before test execution on two missing test
type annotations. Integration supplied those annotations without changing runtime
behavior. Final combined results are recorded below and in the owned test results.

## Production runtime acceptance map

Green defect characterizations assert an observed gap; they do not accept the
stronger invariant. All acceptance here is scoped local evidence.

| Boundary / production implementation | Executable evidence | Release assessment |
| --- | --- | --- |
| `ensureAgents` exact-version inspection → supplied directory → runtime request | `version/version.test.ts`: exact versions despite latest advancing; unsafe configuration/version substitution refused | Exact-version provisioning passes with immutable provider version semantics; deployed bootstrap remains unproved |
| Directory/request identity → persisted task reuse | Same pin replays; changed pin refuses completed/running/ambiguous task without mutation; deliberate attempt bump creates distinct intent | Pass for tested request identity guard |
| Verified configuration → adopted/polled/recovered/cached session | V1–V3 mutable directory, missing pin, wrong observed version | Open: bootstrap must detach/freeze complete pins; runtime does not reject observed-version mismatch |
| `PostgresBudgetLedger.reserve` → role and job rows → dispatch | `reservations/reservations.test.ts`: native PostgreSQL 18.6, four backend sessions; both contenders observed waiting on locks before release | Pass for simultaneous role, job and combined contention, duplicate identity, immutable caps, rollback and dispatch gating |
| Reservation → measured settlement → future capacity | Immutable first settlement, full overage, zero vs invalid usage, both scopes blocked by overage | Accounting/admission pass; overage escalation and automatic operator-task reconciliation remain open policy/workflow requirements |
| Provider create/adoption → SQL CAS → settlement → terminal CAS | `crash/transitions.test.ts`: before-commit rollback / after-commit lost ack; ambiguous lookup; competing finalizers | Stable-usage recovery passes at simulated boundaries; revised usage after settlement reproduces D1 inconsistency |
| Terminal SQL outcome → `withAgentCostDelivery` → application sink | `cost/delivery.test.ts`: stable key, unsuccessful outcomes, sink failure before/after commit, same-key amount conflict, zero vs unknown | Runtime redelivery passes with a conforming fixture sink; actual application durable sink is absent at this base |

## Findings for production owners (no fixes applied)

1. **D1: settlement/task/delivered-cost divergence.** Settle 12,345 micro-USD,
   roll back terminal task CAS, revise fake terminal usage to 23,456, reconstruct
   runtime and retry the identical task. The reservation stays 12,345 while task
   and delivered cost become 23,456. `session-service.ts` finalization ignores
   the first-writer settlement returned by `PostgresBudgetLedger.settle`.
   Require a reconciliation/conflict policy before accepting accounting consistency.
   Exact executable repro: test title `CHARACTERIZATION D1`.
2. **V3: observed version mismatch accepted.** Verify v3, return a measured valid
   session at v4 on create, poll, or ambiguous lookup. It completes, settles and
   delivers; cached replay under the unchanged v3 request returns the v4 output.
   Adoption/finalization and durable reuse need an observed-version policy while
   retaining incurred-cost evidence. See the three `CHARACTERIZATION V3` tests.
3. **V1/V2: trusted configuration obligations.** Mutate the directory's pin after
   successful verification, or omit the pin. Runtime dispatches/reuses without
   attesting the replacement version. Supply all four authorized IDs with positive
   safe-integer exact pins, inspect every exact version's model/tools/handoffs,
   reject incomplete dry-run output, detach and deeply freeze the directory, and
   authorize deliberate attempt/version changes in trusted server composition.
   Runtime composition itself performs no bootstrap verification.
4. **Application boundary remains unimplemented here.** A permissive sink accepts
   the same `naive:<sessionId>` key with changed stored amount. The test simulates
   terminal-row drift through the SQL CAS port; it is not a normal provider replay
   exploit. A fixture SQL sink proves atomic identity comparison and failed-ack
   replay. Parent must test the actual application's durable sink for same-key
   amount/identity conflicts, uniqueness and acknowledge-after-commit semantics.
5. **Overage and operator recovery are distinct requirements.** Measured overage
   can return `completed` while correctly blocking subsequent capacity. Invalid
   terminal usage remains `needs_operator` after provider correction; manual ledger
   settlement alone does not resume it or deliver cost. The two reservation
   characterizations document this without accepting automatic reconciliation.

Detailed repros and per-boundary assertions:
[crash](../tests/track-b/naive-release-assurance/crash/README.md),
[reservations](../tests/track-b/naive-release-assurance/reservations/README.md),
[version](../tests/track-b/naive-release-assurance/version/README.md),
[cost](../tests/track-b/naive-release-assurance/cost/README.md).

## Evidence limits

Actual runtime, persistence migration, task CAS and ledger execute locally. The
provider is always the established fake; provisioning uses in-process structural
ports. Crash cases inject transactional failures/lost acknowledgements rather
than kill an OS process. Runtime reconstruction shares the surviving SQL database.
Native PostgreSQL supplies real independent-session reservation contention; PGlite
cases supply real SQL execution without pooled concurrency proof. No claim covers
live provider deduplication/version guarantees, SDK parsing, hosted database
failover, process/disk recovery, tenant authorization, applied deployed migrations,
deployed trusted bootstrap, or the missing application sink. Passing these tests
does not establish unconditional production release acceptance.

## Final integrated result

The combined command above exited **0**: strict TypeScript passed, then **49 tests
passed, 0 failed, 0 skipped, 0 cancelled, 0 todo**; Node reported **32,645.297792 ms**.
Breakdown: crash 11 (10 acceptance / 1 characterization), reservations 13
(11 / 2), version 13 (8 / 5), cost 12 (11 / 1). Total: **40 scoped acceptance
checks and 9 defect/boundary characterizations**. Native SQL reported PostgreSQL
18.6, four independent sessions, Unix sockets and READ COMMITTED transactions.
Full integrated output: [combined-results.txt](../tests/track-b/naive-release-assurance/combined-results.txt).

Integrated child commits: cost `883267a` → `9b8f760`, crash `b9ab52f` →
`625d6be`, reservations `9f0e3e3` → `42a34f9`, version `c028206` → `8e8c43e`.
The lead's runner commit is `5afc90a`; the final integration commit adds the
strict test annotations, this acceptance map and the combined output.
