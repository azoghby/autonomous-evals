# Strict Naïve callback recovery candidate

**Unapplied source; not deployed.** This increment extends `naive-stage-ownership-integration` at actual repository `3d03209`; the tested assembly preserves main `5da0635`. During final verification main advanced to `187a85d` (feedback-email wording only), now separately merged into actual `track-a`. That unrelated wording change is outside the pinned candidate build, and all candidate preimages are unchanged. It contains 15 source/test postimages and two additive SQL files. Read the manifest and final verification receipt for exact hashes. Earlier approved patches remain adopted; this is a distinct candidate.

## Implemented recovery

Real-mode qualification, trace audit and ordinary report generation now select a strict Naïve service composition. A server helper validates the method/stage pairing and derives the only permitted child key. Mode, method and input are bound into the stage digest; immutable SQL records the recovery profile and exact child key. These three paths contain retained Naïve work, deterministic transformations, keyed accounting and fenced progress. They do not fall back to untracked Gateway work. Lite/mock modes and other methods retain their previous service selection and conservative recovery policy.

Before any create, the session decorator checks current ownership and exact stored request/body/idempotency identity, registers the permitted child and commits intent. The runner checks the declared child key before its own reservation. A strict stage with zero children can therefore recover an interruption before dispatch: no alternative external operation is permitted by that composition. After takeover it may introduce only that same declared child. Other profiles still cannot recover from an empty child set. Existing tasks resume through the original bounded lookup/same-key protocol, never by inventing a new task or provider idempotency key.

Raw pending errors reach stage persistence before conversion to Workflow errors. The three steps allow up to 120 retries, allowing retained polling and recovery after a five-minute expired lease instead of exhausting the previous single retry. This is a bounded retry count, not a wall-clock SLA: each attempt may poll a provider. Unknown usage, ambiguous escalation and budget/authority failures are not silently treated as completion. Measured terminal failures can be replayed from retained evidence; a failed create with no session needs the matching settled-zero reservation. Before retaining any strict callback result, the same completion transaction rereads every registered child and requires terminal evidence. A deterministic report fallback with unknown usage becomes pending instead of releasing its parent hold. This does not release an unmeasured child obligation.

Stage progress writes deduplicate exact stage/milestone/message content in the same transaction as owner validation and event insertion. Different messages remain separate events. Post-step progress outside the stage retains existing behavior.

## Lease and local authority

An executing callback renews its five-minute database lease every minute, serially. Renewal verifies lifecycle, current generation/token and unexpired ownership; a delayed timer cannot revive an expired lease. Completion or pending settlement cancels the timer and waits for an in-flight renewal. Any renewal failure, including an uncertain commit, revokes local authority and blocks completion. Descendants retaining the ALS scope cannot open new guarded publication transactions after it closes. The scope exposes an abort signal, but this does not claim to cancel an already authorized provider request.

Dispatch checks local authority again immediately before sending. SQL publication still checks database ownership in its write transaction. Expert artifact authorization checks local revocation as well as its existing supplied-transaction owner fence. Immutable measured receipts remain ingestible after ownership loss. Timers cannot run during event-loop suspension; database expiry remains the consequential authority boundary.

## Evidence and remaining work

Tests include real PGlite stage authority, actual `AgentSessionService`, `PostgresAgentTaskStore`, `SharedJobBudgetLedger`, result encryption and child fences with fake provider transport. They exercise pending → new generation → same task/session → completion replay, and interrupted pre-dispatch recovery. They also check renewal failure, expired ownership, unexpected child identities, terminal receipt proof and progress replay. The receipt distinguishes focused, composed and actual-source checks. Local retained dependencies are not fresh-install CI, native PostgreSQL contention or hosted Workflow/provider acceptance.

This is not complete evaluation recovery. Suite design/run/investigation/remediation and expert evaluation include untracked lite/Gateway/target/proxy or multiple side effects; those callbacks remain held after interruption. Expert reporting includes blobs and is not opted into the strict ordinary-report profile. Immediate cancellation request acknowledgement, standalone publication/lifecycle paths, parent budget envelopes, combined daily admission, optional V2 proxy admission, conversation sends/cumulative accounting/streaming/idle, factual/sourcing rebase, full roster provisioning and the full Naïve acceptance gates remain open. The broad remediation catch/pending behavior also still needs dedicated integration work. No source adoption, live migration, credential access, provider call, outreach, spend or deployment occurred here.

```sh
python3 docs/naive-stage-recovery-integration/assemble.py /tmp/new-stage-recovery
cd /tmp/new-stage-recovery/apps/web
npx --no-install next typegen
cd ../..
npx --no-install tsc -p apps/web --noEmit
npm test -- --maxWorkers=2
cd apps/web
NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/new-stage-recovery/font-mock.cjs NEXT_TELEMETRY_DISABLED=1 npx --no-install next build --webpack
```
