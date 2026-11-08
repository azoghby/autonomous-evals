# Track B remediation service

Implemented against the locally read `origin/track-a` contracts at
`f28b7a63ec78bbacd5ab7633ccf818a119c99401` (contract digest
`dc7936cf343e023a9f0b3b2c0ee02b3886a1f230397f282ee4aaec84a9b27101`),
on base `9844dec91644bb55b425bdfd445d0160ddd0d867`.
The Track A bootstrap document's remediation gap is addressed by an explicit
server factory; application bootstrap and deployment remain separate work.

## Wiring

Import `createRemediationServices` directly from
`packages/core/src/evals/remediation/index.ts` (package subpath
`@ae/core/evals/remediation/index` where the workspace resolves source subpaths).
There is no new root export, singleton, migration, dependency or manifest change.

```ts
const remediation = createRemediationServices({
  runner: agentSessionService, // AgentSessionService with durable task store + atomic ledger
  checkpoints: new PostgresTextCheckpointStore(applicationSql),
  resolve: resolveAuthorizedRemediation,
});
const evalServices = {
  ...otherExplicitlyComposedServices,
  proposeAndVerifyFix: remediation.proposeAndVerifyFix,
};
// Server-side rich result for evidence persistence / report downloads:
const rich = await remediation.proposeAndVerifyFixDetailed(ctx, { findingId });
```

Apply the existing `evals/integration/migrations/001-text-integration.sql` in
application storage. Use the existing `PostgresTextCheckpointStore` over the
pinned-connection SQL port; transaction callbacks must never automatically retry.
Keep these checkpoints out of disposable target branches.

`resolve(ctx, findingId)` MUST authenticate the caller and job on every invocation,
including completed replay, before returning a detached `AuthorizedRemediation`:

- `job`, actual stored confirmed `finding` and original evidence; current
  `knownSecrets` (explicit detached list, entries at least four characters).
- Stable `binding`: target ID, baseline target/configuration version and environment.
  The isolated trial derives from exactly that configuration. Target version must
  change when any relevant model/configuration changes.
- For text, `original`: admitted frozen suite, full original run, matching binding,
  and the exact objective failing check IDs supported by the finding's check
  evidence. Retrieve these from authorized durable run storage. The service verifies
  job, suite digest, scenario/check membership, full-suite coverage and original
  failing statuses. The resolver establishes the actual canonical finding/run
  association; request prose cannot establish it.
- `trial`: a stable isolated trial ID and secured `send` port, or explicit null.
  The port receives replacement prompt, patch digest, baseline and frozen-suite
  references, and must return the response PLUS an `AppliedReceipt` obtained from
  the actual configuration applied by the isolated target. An echo of requested
  configuration is insufficient. Receipt binds target/version/environment,
  isolated trial, fresh run, scenario, original baseline, frozen digest, patch
  digest and actual applied system prompt. Never mutate or deploy customer config.
- A secured judge returning `PaidResult`, or explicit null. Reuse the existing
  gateway judge and its operation authorization/usage persistence. Wrap it with
  the result envelope; judge token usage with unknown monetary price remains
  unknown, never invented as a measured cost.
- `authorize`: atomically authorize/reserve the exact target/judge operation before
  dispatch, bound to operation ID and input digest, with finite timeout/output/token
  and spend limits. It may return false. Keep reservations held when outcome is
  ambiguous; settle actual usage in the secured ports. The service supplies a
  durable intent before calling this hook. Do not implement this as a boolean
  check against `ctx.budgetMicroUsd`.

The contract adapter uses only `input.finding.id` as a lookup hint and ignores
request finding prose, suite and intake as sources of authority. Compose this
method into Track A's `EvalServices` yourself; imports do not switch real mode on.
Map `TrackBPendingError` to Workflow retry and `TrackBBlockedError` to operator
handling. Do not substitute the Track A deterministic mock on blocked outcomes.

## Execution and verification scope

The engineer runs through injected `AgentSessionService`, using its atomic job/role
budget reservations and durable session identity. Its typed, bounded proposal is
one of `prompt_patch`, `tool_schema`, `guardrail`, `other`. A prompt patch is a
complete replacement system prompt, not executable code. Patch strings are never
passed to eval, a shell, a code runner, or a diff interpreter. Tool/guardrail/other
changes remain proposals and are never claimed applied.

For prompt patches with authorized text evidence and isolated trial support,
execute each of the original 12 frozen scenarios once, sequentially. Reuse
`executeScenario`, `evaluateObjectiveCheck`, rubric admission and verdict/gap
helpers. The ORIGINAL frozen system prompt, reference, scenarios and checks remain
unchanged evaluation criteria. Only the target wrapper sends the replacement
prompt. Preserve separate immutable receipts with actual prompt and patch digest;
never recompute a weakened frozen suite to make admission/checks pass.

`verified` requires original confirmed objective failure(s), a completely assessed
baseline, successful fresh isolated application receipts, all original failures
passing, every fresh scenario passing without unknown/unassessed/infrastructure
states, and zero measured regressions. Counts are scenario pass counts, with
unknown scenarios retained in the denominator. A baseline-passing scenario that
no longer passes counts conservatively as a regression. Even when the finding is
fixed, an unrelated remaining failure prevents `verified`. This conservative
implementation emits `verified` or `not_verified`, never partial success.

This is one bounded execution over a documented 12-scenario scope. It proves no
global correctness, causal certainty for nondeterministic targets, repeated-run
reliability or statistical confidence. Rubric passes retain their judgment basis.
No-reference checks stay not assessed; inconclusive judges stay inconclusive.
Trace-only inputs can produce a concrete proposed patch, explicitly NOT VERIFIED:
fresh execution with actual patch application is required. Re-reading unchanged
historical logs never creates verification evidence. Calendar/tool execution and
production deployment are outside this implementation.

## Durability, costs and reconciliation

Finding identity freezes the actual evidence, full original run, target binding
and trial ID. Changed values under the same finding ID conflict, rather than
silently creating a new attempt. A new deliberate remediation attempt therefore
requires a new authorized finding identity. The initial engineer budget is frozen
separately, so a changed remaining-budget hint on replay cannot create spend.

Every external target/judge send has its own permanent intent. Completed values
are replayed without dispatch. Pending or ambiguous intents never expire, release
or blindly repeat. Operator reconciliation must establish the actual outcome;
there is deliberately no unsafe recovery API here. Only pending durable engineer
polling is released, since AgentSessionService independently fences session creation.
A crash before releasing that polling checkpoint can also require reconciliation.
Scenario snapshots enforce immutable completion and semantic value agreement while
retaining original timestamps across replay.

`PaidResult.costs` carries measured session costs using the existing `CostEntry`
pattern. Ports must return all known costs even for definitive failure responses.
Results/known costs are checkpointed before cost-sink delivery or response-based
blocking; credential-bearing values are replaced with a durable refusal marker,
while measured costs remain deliverable. Replay re-delivers known costs without
repeating paid work. `ctx.recordCost` MUST atomically deduplicate
`meta.idempotencyKey` (`naive:<externalId>`) and reject conflicting values. A lost
acknowledgement may repeat delivery. Engineer costs are persisted before sink
calls, including failed/paused/schema-failed outcomes.

A throwing port means outcome unknown. No cost amount is fabricated. Secured
ports must independently durably retain reservations, observed provider usage and
any late usage/outbox for operator settlement; an exception cannot carry costs
back into this service. Ordinary non-session target/judge monetary accounting is
owned by those ports, because the existing shared Track B CostEntry only represents
measured Naive sessions. Do not mislabel HTTP target or gateway cost as a session.

## Offline validation

`remediation/remediation.test.ts` uses real PGlite checkpoints and fake runner,
target, authorizer and judge. It exercises known buggy/fixed and unchanged bad
targets, absent actual application, missing evidence, cross-job/version/environment
bindings, regression, inconclusive/no-reference checks, restart and lost cost-sink
acknowledgements, ambiguous intents, historical trace and unsupported proposals.
The isolated Track B check harness stages actual locally available Track A contracts.
No provider, network, cloud service, deployment or spend was used. These tests do
not establish production bootstrap integration or secured adapter correctness.
