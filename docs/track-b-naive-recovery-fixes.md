# Track B Naïve recovery fixes

Implementation base: `48519bf`. Changes are limited to the owned session service,
its existing tests, D1/V3 crash and version evidence, ROT-2 cases, and this report.
ECC is disabled. All checks use existing local dependencies and scripted providers;
no cloud/provider calls, secrets, spending, outreach, push, PR, or manifest changes.

## Runtime behavior

- **D1:** finalization consumes `BudgetLedger.settle`'s first-writer amount. After
  terminal CAS rollback or settlement acknowledgement loss, a later observation
  cannot change the stored/delivered amount. Revised usage returns
  `needs_operator / settlement_usage_conflict`, discards the output, and records
  the later observed amount in the diagnostic. Concurrent finalizers use the same
  authoritative settlement even when a different worker wins terminal CAS.
- **V1/V3:** construction detaches and freezes the directory and validates every
  role's ID and supplied positive safe-integer pin. Requests retain that snapshot.
  Adoption records session identity before handling mismatches. Terminal wrong-pin
  sessions retain measured settlement/cost but cannot return valid output. Running
  or inaccessible wrong-pin sessions retain their reservation and require an
  operator. Polling and cached outcomes enforce the durable request pin, including
  historical completed rows. No replacement session or attempt is manufactured.
- **ROT-2:** every outbound create, including same-key recovery replay, clones and
  screens the actual stored message against current `knownSecrets`. Refusal returns
  `needs_operator / credential_in_prompt`, leaves the durable body/key intact, and
  retains the reservation because prior dispatch may have incurred spend. Recovery
  still looks up an ambiguous task before considering replay; discovering an
  existing session does not send the prompt again.

Request identity checks, deliberate attempt bumps, schema validation, and the
existing cost delivery identity remain in place. No ledger interface or PostgreSQL
adapter change is needed. Unknown usage is never synthesized as measured zero.

## Compatibility and remaining policy gaps

Omitted pins remain supported by the existing `AgentDirectory` contract and legacy
callers. Such calls have **no exact-version assurance**; production composition
must supply and verify every exact pin. The runtime validates pin shape and
immutability, not provider configuration, tools, model, or authorization. A caller
that mutates a directory before constructing the runtime must re-verify it.

A quarantined running session may continue spending remotely; automatic cancellation,
usage reconciliation, overage escalation, and operator task resumption remain
policy/workflow gaps. Revised usage does not amend immutable settlement: an operator
must reconcile the discrepancy. Token counts remain the latest observation and are
not asserted to describe the first settled amount. Historical cached mismatch refusal
preserves the row and accounting evidence without migrating old data.

Application durable sink integration, provider deduplication/version guarantees,
deployed bootstrap/migrations, failover, and process/disk crash durability remain
outside this evidence. SQL tests inject transaction rollback or lost acknowledgements;
they do not kill an OS process. PGlite does not prove deployed concurrent PostgreSQL
isolation. Other security findings (including ROT-1) are unchanged.

## Scoped validation

Existing dependency roots:
`/tmp/autonomous-evals-checks.m10du4/node_modules` and
`/tmp/trackb-harness/node_modules`. No installation or timeout increase.

Crash and version checks run sequentially:

```sh
node tests/track-b/naive-release-assurance/crash/run-local.mjs /tmp/autonomous-evals-checks.m10du4/node_modules /tmp/trackb-harness/node_modules/.bin/tsx
node tests/track-b/naive-release-assurance/version/run.mjs /tmp/autonomous-evals-checks.m10du4/node_modules /tmp/trackb-harness/node_modules/.bin/tsx
```

Strict scoped TypeScript compilation also covers these two entrypoints and their
production import closure. The session-service/ROT-2 check stages current production
source, the two exact test files and fakes, and read-only contracts from already-local
commit `8634ceb30f3d98de7ec24b240a4f7549dce80033`. It runs strict no-emit TypeScript
then Vitest with `--maxWorkers=1 -t 'ROT-2|AgentSessionService'`. The other three
rotation assertions are deliberately filtered; no claim is made that their known
gaps are fixed. This local helper is `/tmp/track-b-rotation-unit-check.mjs`.

Final scoped results: **59 passed** (crash 13, version 16, session-service/ROT-2
30), zero failures. Crash/version have zero skips; three unrelated rotation cases
are intentionally filtered by the focused Vitest invocation. Both staged strict
TypeScript checks passed. `git diff --check` passed. Added cases include terminal
wrong-version create retaining measured cost without polling, and running
wrong-version create followed by unavailable polling retaining unknown usage.

Local test commits: `584a954` (unit and ROT-2 regressions), `ade87df` (crash/version
regressions and evidence), `758f5f8` (terminal-create/unavailable-poll regressions).
The implementation/report commit follows these three local commits. Parent owns
integration and push.
