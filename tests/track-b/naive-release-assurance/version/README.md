# Exact provisioned-version assurance

Base: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`.
Owned artifacts only: `tests/track-b/naive-release-assurance/version/**`.

## Run and observed result

The checkout has no `tests/track-b/node_modules`, and the existing Track B manifest does not include tsx. No packages were installed and no manifests were changed. The offline runner stages the exact production dependency closure and this discoverable `version.test.ts`, using installed local dependencies. It uses the existing fake provider, actual runtime, actual SQL adapters, and actual optional SQL migration against PGlite.

With dependencies and tsx installed in the standard location:

```sh
node tests/track-b/naive-release-assurance/version/run.mjs
```

Exact command executed inside the disposable stage:

```sh
tests/track-b/node_modules/.bin/tsx --test tests/track-b/naive-release-assurance/version/version.test.ts
```

Exact successful command in this checkout (reusing local dependencies without modifying their directories):

```sh
node tests/track-b/naive-release-assurance/version/run.mjs '/Users/alexzoghby/.t3/worktrees/YC Hackathon 2/t3-1045f043/tests/track-b/node_modules' /Users/alexzoghby/.t3/worktrees/simulization/t3-52d1553b/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/cli.mjs
```

Result: **13 tests, 13 pass, 0 fail, 0 skipped, 0 todo**, exit 0. Full captured output: `results.txt`. Eight are acceptance tests; five characterize three trust-boundary gaps. Green characterizations are not release acceptance. The runner's two optional positional arguments select an existing dependency directory and existing tsx executable; it never invokes a package manager.

## Acceptance map

| Invariant | Executable evidence | Assessment |
| --- | --- | --- |
| Discovery/current-version movement must not advance the exact verified pin | List v3, identity get returns latest v4 with unsafe latest handoffs, exact getVersion(3) is safe; all four roles dispatch/store v3 | Pass for immutable exact-version provider semantics |
| Explicit configured old version remains exact | Configure v2 while latest becomes v8; only getVersion(2) is inspected | Pass |
| Returned exact version/config must match | getVersion returns v4 instead of v3, or exact config permits handoffs; provisioning throws without usable directory | Pass |
| Identical exact pin can reuse durable completed output | New runtime instance replays SQL result, no create/get, idempotent SQL cost redelivery | Pass |
| Changed pin must not reuse task | Completed, created/running and ambiguous rows return `task_input_changed`; complete task/reservation/scope/cost SQL snapshots unchanged, zero create/get/list/cost dispatch | Pass |
| Deliberate attempt bump may use a changed pin | v3 attempt 1 then v4 attempt 2 stores separate intents, reservations and idempotency keys | Pass; authorization to bump belongs to caller |
| Verification remains bound to runtime directory | V1 mutation repro | Bootstrap obligation; runtime has no attestation/freeze |
| Every runtime dispatch requires an exact version | V2 omitted-version repro | Not enforced by runtime/type |
| Observed session version must match verified/requested version | V3 initial response, poll drift, and ambiguous lookup recovery repros | Gap: wrong-version output is completed, settled and delivered; initial-response case also proves durable reuse |

## Minimal repros and out-of-scope fixes

**V1 — verified directory is mutable caller configuration.** Call `ensureAgents` against a safe exact-v3 local port, construct `createPostgresAgentRuntime({ directory, ... })`, mutate `directory.commercial.agentVersion = 4`, run the first task. No v4 inspection occurs; create and persisted request use v4 and complete. `AgentSessionService` retains and reads caller configuration (`session-service.ts`, constructor/requestBodyFor); `runtime.ts:35` explicitly documents authorized configuration as the caller's responsibility. This is a trusted-bootstrap requirement, not evidence of an unauthenticated exploit. Suggested owner action: produce a detached, deeply immutable verified directory and never accept request-selected agent IDs/versions. Runtime defensive cloning/validation would narrow the boundary.

**V2 — a missing version is accepted.** Remove `commercial.agentVersion` from the runtime directory, run, then construct a fresh runtime with the same unpinned directory and run the same spec. Create omits `agent_version`; fake provider chooses v9; SQL persists an unpinned request with observed v9 and returns the cached answer on replay. `AgentDirectory` deliberately types the version optional (`evals/types.ts:70`); `requestBodyFor` deliberately omits it when absent. Suggested owner action: trusted bootstrap must reject incomplete/nonpositive/non-safe-integer pins before runtime construction and require all four verified roles. Do not promote a partial `dryRun` result to a full directory without checking `missing`. Production exact-pin policy could also use a stricter runtime directory type.

**V3 — observed version mismatch is not rejected.** Supply a verified v3 directory; fake session reports v4 with valid JSON and measured usage. Runtime stores `requestBody.agent_version=3`, `agentVersion=4`, state `completed`, settled 12,345 micro-USD and a delivered SQL cost. Replay under the unchanged v3 pin returns the v4 answer without provider calls. Separate tests show the same gap when create first reports v3 but poll later reports v4, and when an ambiguous create is recovered by task-key lookup at v4. `adopt` records the supplied snapshot version (`session-service.ts:374`), `finalize` overwrites it without checking the request pin, and cached reuse compares requested bodies rather than the stored observed version. Suggested owner action: validate session identity/version on adoption, lookup, polling and cached reuse; quarantine mismatches for operator reconciliation, preserve evidence and reservations, and avoid treating wrong-version output as accepted evaluation output. Usage/cost reconciliation must still account for actual incurred spend.

No production fixes were made.

## Actual trusted-bootstrap requirements and limits

Provisioning and runtime composition are separate APIs. Runtime construction performs no provisioning, model/tool/handoff attestation, migration or authorization. For an exact-version release claim, trusted server composition must supply all four authorized IDs with positive safe-integer versions obtained from successful exact-version verification; retain the checked model/config policy and complete listing; detach/freeze nested pins; gate deliberate version/attempt changes; and use immutable provider version semantics. Advancing provider latest alone is harmless when the exact pin remains unchanged. Re-verifying provider latest on every runtime reuse is not required by the tested contract.

The structural provisioning port uses only in-process functions; it does not instantiate an SDK client. The fake provider scripts adversarial version responses, which proves consumer behavior, not that a real provider violates exact pins. PGlite executes real PostgreSQL-compatible SQL but does not establish pooled PostgreSQL concurrency, durability across database/process restart, applied production migrations, tenant authorization, deployed bootstrap behavior, SDK response parsing, or cloud/provider acceptance. No network/provider/cloud calls, credentials, spend, outreach, deployment, push or PR were used. All runtime instances share the same local SQL database within each case; fresh runtime replay is not a process-restart test. Off-limits app/platform/contracts/manifests, other team tests, workflow/chat/data documentation and eval packs were not edited.
