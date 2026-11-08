# Independent remediation review

Reviewed production HEAD `74ac48672d9ef91dfb9dcbf4d0dd393aa6cadd5c` (the requested
current main revision; supersedes the original `f0af5cb` task reference).
Only `tests/track-b/remediation-review/**` and this document are changed.
No ECC, network, provider, cloud calls, installation, or spend.

## R1 — Low: rejected initial budget leaves an unstarted attempt permanently pending

Location: `packages/core/src/evals/remediation/index.ts:148–156`.

`claim(engineer_budget)` writes a permanent pending checkpoint **before** checking
whether the initial `ctx.budgetMicroUsd` is a positive safe integer. A zero hint
throws `Positive bounded engineer budget required.` without releasing that claim.
A subsequent invocation with a valid positive budget throws
`Engineer budget intent requires reconciliation.` forever. No engineer session,
reservation hook, target, or judge was invoked. There is no reconciliation API.

Minimal reproduction, through real PGlite:

1. Resolve a legitimate confirmed finding with a complete admitted baseline.
2. Call with `ctx.budgetMicroUsd = 0`; observe the validation error.
3. Inspect `remediation_engineer_budget`: state is `pending`.
4. Call the same authorized finding with `ctx.budgetMicroUsd = 1_000_000`;
   observe permanent reconciliation blocking instead of starting work.

This is a recoverability defect reachable via an invalid/exhausted initial
context hint, not an authorization bypass or redispatch vulnerability. Its blast
radius is that attempt; arbitrary callers must still pass the resolver's job
access checks. Crashes after claiming other checkpoints are a separately documented
operator-reconciliation policy, not reported again as defects here.

Minimal fix: release this freshly claimed **budget-only** checkpoint before
blocking on invalid input (no external action can yet have occurred). Alternatively
validate before creating a new budget claim while preserving completed budget
replay when the current remaining-budget hint has fallen to zero. Do not release
external target/judge intents. Add the zero-then-positive retry regression and
retain the existing frozen-budget replay control.

Parent fix: invalid initial input now releases only the newly claimed budget
checkpoint before rejecting. The R1 test is an ordinary acceptance regression:
it requires a releasable `ready` budget checkpoint, no paid calls, and a successful
retry with a positive budget. Completed budgets and external dispatch intents
remain immutable. The original results artifact records the pre-fix review.

## G1 — Integration gap: secured application attestation is not implemented here

No concrete resolver, isolated remediation target adapter, receipt producer, or
application bootstrap of `createRemediationServices` exists in this checkout.
Only the factory, fake-port tests, and wiring documentation reference these APIs.
`targets/text.ts` provides the ordinary request client, not remediation isolation,
canonical target/version authorization, or receipt issuance. The service documentation
explicitly leaves this composition to the application.

The receipt equality check establishes internal consistency, not independent
truth. A privileged trial port can return canned passing responses and echo the
requested prompt and binding into a fabricated receipt; the service returns
`verified`. The `INTEGRATION GAP` expected-failure test records exactly this
limitation and asserts the desired `not_verified` result. This is a **trusted-port
lie**, not a demonstrated caller-reachable exploit. Request finding prose cannot
select that port or supply the authoritative original run. No production claim of
actual isolated application can be made from these unit tests alone.

Before integration acceptance, supply a server-owned resolver that authenticates
job/tenant access on every replay, reads canonical finding/run/suite/configuration,
and supplies the current secret policy. Supply an isolated adapter which builds
its receipt from the actual dispatched configuration (including model/version,
environment, original user message, and replacement prompt), binds the response
to that request, and durably reserves/settles bounded usage. Test it with an
independent transport observer and negative binding/isolation controls. No new
cryptographic signing requirement is implied when the adapter is in the same
trusted server boundary.

The additional positive control executes the real `createTextTarget` and chat
client against an injected **offline** transport. It checks all twelve outgoing
model/system/user message bodies and derives the prompt receipt from the observed
body. This verifies the available core request path, not a deployed secured
adapter or remote provider behavior. Authorization/reservation atomicity, tenant
ownership, version accuracy, sink deduplication and measured usage truth remain
trusted integration responsibilities, not proven by boolean or in-memory mocks.

## Evidence and scope

`run.mjs` stages this checkout without modifying production, loads the actual
contracts from the pinned locally available Track A revision
`769537d0fce974b355999c8cbcc637796074d0c2`, and runs strict TypeScript over all staged
source, original evals/judges tests (including the original remediation tests),
and independent review cases. Dependency modules are reused locally.

```sh
TRACK_A_REF=769537d0fce974b355999c8cbcc637796074d0c2 \
REMEDIATION_REVIEW_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules \
node tests/track-b/remediation-review/run.mjs
```

Use an equivalent installed local module directory when that temporary path is
unavailable. The runner never fetches or installs. `results.txt` contains the
captured results and explicitly identifies both expected-failure characterizations.
Final validation: strict types passed; 28 test files, 457 passing assertions and
2 explicit expected failures (459 total), none skipped/todo. This includes all
429 original evals/judges cases (23 original remediation cases) and 30 independent
review cases. A successful harness exit does not mean R1 or G1 is fixed.

| Boundary | Review evidence / conclusion |
| --- | --- |
| Actual request vs receipt | Real text-client transport control; every receipt binding field tampered separately prevents verification; privileged fabricated receipt remains G1. |
| Frozen identity and checks | Original suite/run remain byte-identical; original user messages and suite digest retained; missing/duplicate scenarios, missing check, mismatched run/digest/version and nonfailed original check rejected before paid work. |
| Fresh failure verification | Known prompt-sensitive buggy/fixed target; original S01 failure passes fresh; unchanged bad target and wrong applied prompt remain unverified in original tests. |
| All twelve / regressions | All original scenarios execute with original checks; unrelated failure prevents verification; baseline-pass to fresh infrastructure error conservatively counts regression. |
| Assessment gaps | Original no-reference and inconclusive tests retained; independent unassessed baseline prevents verification; definitive target errors remain infrastructure errors/inconclusive across replay. |
| Trace / unsupported | Original tests assert trace-only and tool-schema/guardrail/other proposals are never verified and never dispatched. |
| Job / tenant / environment / version | Core rejects cross-job/environment/version baseline and replay identity changes; resolver is called on completed replay and its denial is honored. Tenant authentication and canonical run ownership remain resolver obligations (G1). |
| Durable paid intents | Real PGlite pending row precedes authorization; ambiguous reservation never dispatches/retries; original ambiguous target and target-cost lost-ack tests retained. |
| Budget / cost replay | Judge denial records prior target costs, then blocks without target redispatch. Definitive target failures retain costs. Failed engineer cost survives a lost sink acknowledgement and is redelivered before blocked replay. Initial invalid engineer hint exposes R1. |
| Known secrets | Secret engineer proposal and judge response persist refusal markers and known costs, never secret content; replay does not repeat paid work. Original secret target refusal retained. |

No new caller-reachable false-verification bypass was demonstrated with honest
secured ports and authorized canonical evidence. This conclusion is limited to
this bounded offline core review. Known rubric source/hierarchy defects are outside
this remediation-specific review and are not duplicated as findings.
