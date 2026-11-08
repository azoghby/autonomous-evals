# Shared job budget integration candidate

**Unapplied, not deployed.** Twenty incremental source/test paths and two additive SQL files, requiring the internal MCP13 + copilot dispatch6 candidates first. The combined chain has 36 unique source/test paths. Reviewed against actual `09997e4`; fetched main is `5da0635`. No actual application/core file, database, provider setting or live session was changed. This is progress toward the full Naïve plan, not an activation or full-budget-completion receipt.

## What this layer connects

`job-budget-authority.ts` derives the cap from canonical `jobs.package` and `JOB_BUDGET_MICRO_USD` ($3 ordinary/$5 comparison). Admission locks the job before reservation/operation/model scope locks. Exposure includes public cost rows, outstanding public Workflow reservations, accepted model commitments, and outstanding Gateway turn holds. The cached `jobs.budget_reserved_micro_usd` value is not authoritative. Negative/unsafe persisted amounts fail closed; actual overages are retained. Expert honorarium promises remain under their separate caps; recorded job costs still count.

`SharedJobBudgetLedger` wraps the existing model ledger within the same pinned transaction. It preserves role/period caps and immutable native reservation identities while adding the shared job check. Shared denials retain the original request digest and decision even if capacity later changes. Current generic `buildAgentDeps`, expert-text judge composition, and the copilot candidate use this wrapper. Unmounted exported runtime/proxy/remediation library constructors still use their original ledgers and must not be mounted without this boundary.

`job-budget-receipts.ts` connects the actual cost sink to retained generic-session or copilot dispatch identities. Only an exact Naïve session receipt, canonical job, reservation binding and equal measured settlement can replace the model debit with its public cost row. Matching an amount or role alone is insufficient. Unknown historical bindings and `naive_proxy` receipts remain conservatively additive; costs are never silently omitted. The optional bridge lookup leaves a legacy-only cost sink functional before this schema exists.

Workflow `withBudget` and the legacy budget adapter now use shared admission/release rather than unlocked reads followed by independent inserts. The callback gets the admitted stage allowance. Successful callbacks release their hold; exceptions retain it. Cancel, failure and budget-pause lifecycle steps no longer bulk-release all holds: a job status does not establish that provider work stopped.

Gateway **job** chat now reserves a durable turn before `streamText`, records dispatch before any provider attempt, and disables automatic provider retries for that turn. Its job/message identity cannot dispatch twice. Each step's cost and immutable receipt are saved atomically; only measured costs offset its outstanding hold. A known terminal stream with all measured steps releases the residual; errors, aborts, missing measurement and estimates retain the unknown remainder. Recorded overage is not clipped. The six-step/1,500-output-token limits remain, with a stop after the known allowance is consumed. A $0.30 admission allowance is **not** a provider-enforced dollar ceiling: a single Gateway call can overrun it before its usage is known. Sandbox chat remains on its existing path.

All new SQL is additive. Operations, admission decisions, receipt links, Gateway turn identity and step evidence are immutable or monotonic, with deletion rejected. Pinned transaction adapters use READ COMMITTED, no callback retry, and discard connections after uncertain commit or rollback failure.

## Remaining correctness and rollout gates

- Workflow retry identity is still the open `(job, agent)` hold. It does **not** fence two concurrent callbacks. Current callsites invoke stages sequentially, and wrapped model calls have separate admission, but the wrapper itself is not an at-most-once stage executor. Durable stage/attempt ownership and explicit parent-child envelopes remain required before claiming complete concurrent enforcement. No parent hold is subtracted without proof; this can reject affordable work.
- Naïve proxy and unlinked historical measured costs can be counted twice. Add exact retained proxy request/reservation links before claiming accurate available headroom for that path.
- Gateway job turns serialize their own owner daily admissions, but Naïve uses a calendar-day scope and Gateway uses rolling 24 hours; sandbox has no corresponding reservation mutex. A single combined customer/day gate is still absent. This layer is **job-scoped**, not a company-global or combined daily budget guarantee.
- Unknown/aborted Gateway turns intentionally cannot simply retry a new provider attempt under the same message. Recovery/reconciliation and usable pending/history UI remain needed. Parent capability/session-send/cumulative-accounting and authenticated idle gates also remain open.
- The patch assumes coordinated migration and application rollout. Do not run mixed legacy advisory-first reservation code and new job-first code against active jobs without a drain/fence strategy. No native PostgreSQL contention test ran here (local PostgreSQL binaries were not available); PGlite tests do not prove cross-connection locking.
- This layer was composed on actual source plus the MCP/dispatch chain, **not** factual39/sourcing26. It overlaps their application integration surfaces; rebase and verify the combined owner candidate before applying both. Existing pending source approvals do not authorize this new patch. SQL and live activation require their own concrete owner review.

## Verification

The final numbers and artifact hashes are in `validation/results.json`. Focused tests use actual PGlite SQL and the actual cost sink, with fake provider transport. They cover mixed public/model holds, sticky denial, exact receipt substitution, immutable evidence, unknown/estimated spend, failure retention, Gateway replay, overage, current ownership, uncertain commit handling and atomic rollback. A full composed suite, web types and offline-font production build are required before recording the checkpoint.

```sh
python3 docs/naive-shared-budget-integration/assemble.py /tmp/new-shared-budget-stage
cd /tmp/new-shared-budget-stage/apps/web
npx --no-install next typegen
cd ../..
npx --no-install tsc -p apps/web --noEmit
npm test
cd apps/web
NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/new-shared-budget-stage/font-mock.cjs NEXT_TELEMETRY_DISABLED=1 npx --no-install next build --webpack
```

The assembly verifies its dependency chain and every pre/postimage. Dependencies are the retained local installation, not a new locked-install CI receipt. `owner.patch` is incremental; SQL files remain separate and unapplied. No credentials were read or requested, and no provider call, outreach, spending, migration or deployment occurred.
