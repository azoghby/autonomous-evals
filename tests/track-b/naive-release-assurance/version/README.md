# Exact provisioned-version recovery regressions

Owned artifacts: `tests/track-b/naive-release-assurance/version/**`. ECC disabled;
only existing local dependencies, PGlite, production runtime/adapters and scripted
provider ports are used. No SDK, cloud/provider request, secret, install or spending.

Run sequentially with the crash suite:

```sh
node tests/track-b/naive-release-assurance/version/run.mjs /tmp/autonomous-evals-checks.m10du4/node_modules /tmp/trackb-harness/node_modules/.bin/tsx
```

The runner stages the production dependency closure and this test, then removes it.
Scoped result: **16 passed, 0 failed/skipped/cancelled/todo** (1,143.915 ms).
Strict no-emit TypeScript compilation of crash/version roots and imports passed.
Captured scoped results are in `results.txt`.

The existing acceptance cases retain exact provisioning despite provider latest movement,
explicit older pins, unsafe configuration refusal, same-pin replay, changed-pin refusal
without mutation and deliberate attempt separation. Converted V1 proves runtime construction
detaches nested caller pin records: mutation after construction cannot select another version
or invalidate cached replay. Supplied nonpositive, fractional, nonfinite and unsafe integer
pins are rejected before dispatch.

V3 regressions refuse output on wrong versions observed during create, later polling,
ambiguous lookup and reuse of a legacy completed SQL row. Valid terminal usage still settles
and delivers incurred cost. A running wrong-version session preserves its identity and
unsettled reservation, returns an operator outcome and never accepts its output. Provider
create/recovery identity remains unchanged; no second create hides the mismatch.

Omitted pins remain an intentional compatibility mode because `AgentDirectory` currently
allows them. That control proves legacy unpinned replay only; it does not provide exact-version
assurance. Trusted bootstrap must still supply all four authorized, verified exact pins for
that stronger guarantee, check complete provisioning and configuration, and authorize
attempt/version changes. Runtime snapshotting does not itself attest configuration or
prove a supplied pin was ever verified.

PGlite exercises real SQL but does not prove pooled PostgreSQL isolation, deployed migrations,
RLS, process/disk durability or provider immutability. Scripted version violations prove the
consumer refusal behavior only. Accounting consistency does not settle operator policy for
revised provider bills or automatically reconcile unknown usage.
