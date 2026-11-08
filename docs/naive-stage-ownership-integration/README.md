# Workflow stage ownership candidate

**Unapplied source candidate; not deployed.** This layer extends the MCP → copilot dispatch → shared budget → proxy receipt chain. Reviewed repository checkpoint: `ee7482a`; fetched main: `5da0635`. There are 21 incremental source/test paths, 54 unique composed paths, and one separate additive SQL file; the manifest pins their exact hashes. Earlier approved source patches are already adopted; this is a separate candidate, not an application of those historical patches.

A logical stage now has an immutable input digest, current customer/environment binding, unique budget reservation, leased owner token and generation. Workflow run/step/attempt metadata is diagnostic invocation evidence, not a fresh payable child identity. Repeated invocations cannot enter the same active callback. Completed stages replay encrypted, bound results and do not rerun providers. Completion and release of the exact Workflow reservation share a transaction. Pending, expired and uncertain stages retain their holds.

The app mounts Naïve session and runner decorators through optional core composition hooks. Before create, the decorators validate the retained task, exact request body and idempotency key, register the child, and commit dispatch intent under current stage ownership. Existing bounded same-key ambiguous-create recovery remains the core runner's responsibility. Network calls never run while holding the stage transaction. An already authorized call may finish after lease expiry; its immutable measured receipt is evidence, not permission to publish. Measured costs remain ingestible after ownership loss.

Scoped job state, progress, findings and remediation writes check the owner and write using the same pinned transaction. Committed terminal or hold states revoke stage authority; measured accounting remains separate. The cancel API still queues a Workflow event rather than immediately committing cancellation, so request acknowledgement alone is not this revocation boundary. Expert artifact/binding authorization also checks stage ownership in the supplied write transaction. Expert report persistence uses a non-step helper so it retains the calling stage's AsyncLocalStorage scope; the ordinary standalone report persistence step retains its existing behavior. Private blob writes can leave orphan objects if later SQL publication is rejected. This does not claim all report or lifecycle publication is stage-owned.

## Recovery is deliberately incomplete

The store supports generation takeover only from retained child evidence; new child keys are denied after takeover. The Naïve reader checks exact retained task/body/key identity and terminal or resumable state. Zero children and unsupported child protocols cannot prove safe recovery.

More importantly, a known Naïve child does not prove there was no untracked side effect in the same callback. Runtime takeover therefore requires an explicit `recovery: 'retained-children'` descriptor after complete coverage is established. **No current production callsite opts in.** A pending/interrupted callback stays held for reconciliation; this candidate must not be activated as though it provides automatic polling. Ordinary service error conversion can leave a pending task's parent stage running until its five-minute lease expires. Long-running callbacks also lose publication authority after that lease; heartbeat/renewal and comprehensive recovery remain required.

Lite/Gateway model calls, target requests and expert proxy dispatch lack complete stage child protocols. Ordinary report persistence, post-step writes and lifecycle paths outside a stage scope retain their existing controls. Current fencing is a bounded implementation, not completion of the full stage-fencing design or automatic expert sourcing.

## Verification and adoption

`validation/results.json` records exact verification. Tests use local PGlite and fake providers; they do not prove native PostgreSQL contention or hosted Workflow behavior. Dependencies are retained locally, not a fresh locked-install CI receipt.

```sh
python3 docs/naive-stage-ownership-integration/assemble.py /tmp/new-stage-owner
cd /tmp/new-stage-owner/apps/web
npx --no-install next typegen
cd ../..
npx --no-install tsc -p apps/web --noEmit
npm test -- --maxWorkers=2
cd apps/web
NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/new-stage-owner/font-mock.cjs NEXT_TELEMETRY_DISABLED=1 npx --no-install next build --webpack
```

Assembly verifies parent dependency hashes and every pre/postimage. Apply prerequisites and this increment only after source ownership authorization and a complete integration review. Factual39/sourcing26 overlap this independent chain and require rebase before joint adoption. Combined customer daily admission, parent envelope coverage, optional V2 proxy admission, Gateway unknown-turn reconciliation, conversation sends/streaming/idle, complete roster provisioning and full Naïve acceptance remain open. No live migration, provider call, credential access, outreach, spending or deployment is performed by this artifact.
