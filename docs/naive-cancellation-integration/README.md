# Durable cancellation and pending remediation candidate

**Unapplied source, not deployed.** This layer extends `naive-stage-recovery-integration` with 28 source/test postimages and one additive SQL migration (75 unique composed paths). It preserves 19 upstream files through exact Git blob overrides, bringing the tested composition to actual `c4fcf0f` / main `6793f48`, including Track A's feedback approval, home stats and public sample changes. The overrides are preservation of already merged upstream work, not new owner-patch changes. The manifest pins both sets separately.

## Cancellation admission and delivery

REST and MCP call the same SQL authority. The caller supplies its server-authenticated customer ID; the transaction locks the canonical job, reloads the customer, rechecks current ownership/operator policy and applies existing `decideCancel` rules. MCP explicitly disables operator escalation. Existing operator-own-job restrictions remain unchanged. Unrelated callers cannot inspect retained requests.

One transaction retains the original reason, records the request and any operator intervention, commits `jobs.state='cancelled'`, and inserts one cancellation progress event. It releases no provider holds. A retry returns the original receipt without replacing its reason or duplicating messages/progress. Committing the terminal state makes existing late-payment handling recognize cancellation without waiting for Workflow event consumption; this is not a new refund policy or proof of all payment/provider races.

After commit, delivery independently attempts Checkout expiry and Workflow notification. REST returns durable acceptance even if those effects remain pending. The existing authenticated stale-jobs cron drains cancellation rows independently of stale-job selection. Each attempt is recorded before external effects; oldest-attempt-first ordering prevents permanently missing hooks from starving later requests. Failed effects retain their own flags and retry. No job is restarted merely to notify it.

The new strict Checkout helper distinguishes no session, verified terminal session, verified expiry, and errors. Missing credentials, transport/auth/rate failures and unverifiable expiry remain pending rather than being acknowledged as successful cleanup. The existing best-effort helper is preserved for its other callers. Delivery is **at least once**: a crash after an external success but before its acknowledgement may repeat the call. Cancellation finalization and recorded progress are idempotent. A permanently missing hook stays pending; fair rotation prevents it blocking other work, but operator reconciliation remains necessary for those rows.

## Authority and publication

The durable request immediately rejects stage claims, completion replay, lease renewal and completion through the same job-lock authority. Scoped and standalone state/progress/finding/remediation writes check cancellation in their SQL transaction. Commercial agent messages and quote creation are also fenced; authenticated customer/operator conversation writes keep their existing policy. Partial-result cleanup now checks state, report and cancellation while holding the job lock and deletes findings/remediations with its progress event atomically.

Lifecycle transitions no longer read eligibility and then write through another connection. They check terminal/cancellation state, update state/extra fields and append progress atomically. Cancellation wins over late failure or budget paths; delivery retries replay the retained delivered timestamp. Duplicate cancel events do not reopen jobs or duplicate cancellation progress. Already-authorized provider requests may finish, and immutable measured costs remain ingestible. Unknown budget holds remain retained. This is not a claim of instantaneous physical provider cancellation or coverage of every mixed target/proxy side effect.

## Pending remediation

The remediation step catches semantic verification failures only around the service call. Raw/transformed pending and authority/cancellation control errors propagate; pending marks the parent stage pending rather than retaining a successful `null` result. Ownership checks and findings/remediation publication sit outside the semantic catch. Definitive failures still produce a sanitized note. Mixed remediation recovery is not enabled by this change.

## Verification and remaining gates

The final receipt distinguishes actual-source tests from the composed candidate. Local PGlite tests cover transactional authorization, immediate terminal state, immutable/idempotent requests, failed commit/rollback connection disposal, fair retry rotation across 61 requests, stage/lifecycle/publication cancellation, progress deduplication and preserved measured accounting. Fake Checkout/Workflow transports cover delivery failures and strict verification. These do not prove native PostgreSQL contention, real Stripe/Workflow behavior, or hosted acceptance.

Source ownership adoption remains separate. Mixed callback recovery, full parent/daily budget authority, factual/sourcing rebase, conversation sends/streaming/idle, roster provisioning and full Naïve acceptance remain open. No real credential/provider access, migration, outreach, spending or deployment is performed by this artifact.

```sh
python3 docs/naive-cancellation-integration/assemble.py /tmp/new-cancellation-stage
cd /tmp/new-cancellation-stage/apps/web
npx --no-install next typegen
cd ../..
npx --no-install tsc -p apps/web --noEmit
npm test -- --maxWorkers=2
cd apps/web
NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/new-cancellation-stage/font-mock.cjs NEXT_TELEMETRY_DISABLED=1 npx --no-install next build --webpack
```

Assembly requires the retained repository Git blobs and locally installed dependencies. It verifies upstream pre/postimages, dependency manifests, candidate pre/postimages and SQL; it does not install, activate or contact providers.
