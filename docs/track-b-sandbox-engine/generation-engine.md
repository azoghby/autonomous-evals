# Durable sandbox engine generation

`createDurableSandboxEngine` now supports the continuation from `68e7fab` (adopted on parent `6b9ee17`) on
actual `engine.generate`. Trusted server construction opts in with:

```ts
const engine = createDurableSandboxEngine({
  ...engineConfig,
  generation: { ...engineConfig.generation, runner: durableAgentSessionService },
  generationContinuation: {
    executionIdentity: 'gates-v1:directory-pins-v1:namespace-v1:budget-period-v1',
  },
}, persistenceConfig);
const result = await engine.generate(originalRequest);
```

The runner must be an actual `AgentSessionService` backed by the durable task and
budget stores. The continuation creates no provider, network client or task
identity. The caller must preserve its service directory/version pins,
idempotency namespace, budget period and execution policy across restarts, and
change `executionIdentity` when those contracts change. The engine additionally
binds gate and evaluation versions. Changed identity blocks an existing operation;
it never authorizes replacement work.

Omitting `generationContinuation` preserves the legacy permanent generation
binder, including its unresolved replay behavior. There is no migration or
operator takeover path in this patch. A custom generation constructor cannot
replace the durable engine's installed generation composition.

## Admission and evidence

Before invoking the continuation, a short SQL transaction claims and completes an
admission marker under the **same primary key used by the legacy binder**:
`sandbox_generation_binding_v1`, scoped by the persistence scope, with the hashed
`${jobId}:${operationKey}` adapter key. Its digest binds the original request and
execution identity. A preexisting legacy claim in any state is refused without
modification. A concurrent old/new caller is serialized by that primary key;
whichever is admitted first excludes the other. Once admitted, legacy dispatch
also cannot obtain `bound`. A crash before the admission transaction commits
rolls it back; a lost commit acknowledgement blocks the current invocation and
requires a later identical invocation to read the authoritative marker.

The engine's actual gate callback still runs the existing SQL-backed gates and
grading bridge. Its assessment receipt includes the complete gate evidence,
including run identities, verdicts and evidence digest. The continuation persists
that full receipt, then delivers it to an observer on both first completion and
replay. This restores the engine's accepted evidence map even when the assessment
callback is suppressed. Artifact construction verifies the evidence through the
existing `createSuiteGateArtifact`. Replay never fabricates passing receipts or
reruns gates to reconstruct missing evidence. Canonical JSON artifact content,
digest and run IDs are identical; PostgreSQL jsonb can reorder object keys.

Job, scope, generation configuration and authorization callback references are
snapshotted at construction. Each phase still invokes those callbacks to resolve
current authority. Both engine and persistence generation authorization must
succeed. Tenant identity must match `job.customerId`, including at the standalone
continuation constructor. Generation and persistence secret sources are combined
and retained across engine calls; restarted processes must supply revoked secrets
as well as current credentials.

## Recovery limits

The continuation limitations in [generation-continuation.md](generation-continuation.md)
still apply. Only an authoritative adopted session ID permits pending polling.
Unknown create, uncertain gate/cost delivery or incomplete phase receipts retain
permanent fences. There is no timeout takeover, automatic retry of uncertain
effects, scheduler, legacy migration or reconciliation API. A pending result
requires the caller to schedule another invocation with the original request.
Service construction and execution identity remain trusted server responsibilities;
`instanceof` cannot attest provider/store correctness. This patch does not change
run/outcome, grading, media, schemas or app wiring.

## Local validation

The new harness stages current source and tests with existing cached dependencies,
then performs strict TypeScript checking and real native PostgreSQL tests. Gate
worlds use the existing local SQL fixture/runtime and deterministic grader. Only
the provider is a controlled local fake; no paid/network/cloud calls are made.

```sh
TRACK_B_NODE_MODULES=/path/to/existing/node_modules \
CONTINUATION_PG_BIN=/path/to/existing/postgres/bin \
node tests/track-b/sandbox-generation-engine/run.mjs
```

The suite covers actual engine pending-to-complete continuation across a PostgreSQL
restart, same adopted session, one cost delivery and budget settlement, no repeated
gate/target work, exact canonical artifact replay, competing legacy admission,
legacy operation preservation, changed identity, revoked authority and tenant or
mutable construction-scope attacks. See the implementation handoff for exact run
counts. Repository-wide checks depend on the checkout's installed application
dependencies; this local harness does not claim deployment or provider acceptance.

The parent integrator owns the root ledger and branch integration; this sub-agent
keeps its commit to the explicitly assigned source, new tests and this document.

Validated locally with cached dependencies (including a compatible `ipaddr.js`
type version), with no dependency installation:

```sh
TRACK_B_NODE_MODULES=/tmp/workflow-bootstrap.JpxCTM/node_modules \
TRACK_B_IPADDR_MODULE=/tmp/sandbox-generation-deps.cBCEai/node_modules/ipaddr.js \
CONTINUATION_PG_BIN=/tmp/agent-persistence-runtime/node_modules/@embedded-postgres/darwin-arm64/native/bin \
node tests/track-b/sandbox-generation-engine/run.mjs

TRACK_B_NODE_MODULES=/tmp/sandbox-generation-deps.cBCEai/node_modules \
CONTINUATION_PG_BIN=/tmp/agent-persistence-runtime/node_modules/@embedded-postgres/darwin-arm64/native/bin \
node tests/track-b/sandbox-generation-continuation/run.mjs
```

The engine harness passed strict TypeScript and 12/12 tests across two files,
zero skipped (56.20 seconds). The continuation regression harness passed strict
TypeScript and 11/11 native SQL
tests, none skipped. The repository commands were attempted: `npm test` cannot
find Vitest; offline `npx tsc -p apps/web --noEmit` cannot resolve the actual
workspace compiler. Invoking the cached actual compiler confirms unresolved
Next/React/workflow/botid and workspace dependencies. No repository-wide pass is
claimed and no manifests were changed.

## Parent integrated verification

After integration at `7f492e2`, the parent reran the actual durable-engine suite using the retained workflow dependencies with ipaddr.js 2.5.0 supplied explicitly. Strict TypeScript and all **12 tests** passed, including native PostgreSQL restart, adopted-session continuation, exact gate artifact replay, racing legacy/new admission, changed identity, tenant binding and revoked authorization. No skipped tests or live provider calls occurred.
