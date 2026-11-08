# Naïve cost settlement: Track A adoption requirement

This is a source-derived integration handoff for `docs/NAIVE_PLAN.md` Phases 0–1. It is **not an applied migration, app patch or deployed accounting receipt**. Track A owns the application cost sink, Drizzle schema and migrations. Track B must continue delivering measured costs on replay; suppressing delivery in process memory cannot fix a lost database acknowledgement.

## Current source behavior

- `packages/core/src/agents/session-service.ts` reconstructs session cost evidence from durable task rows. It records source `naive_session`, the external session ID and whether usage was measured; unknown usage is distinguished by `measured:false`.
- `packages/core/src/evals/service-adapter.ts` exports `toContractCost`: source `naive`, session ID, micro-USD and `meta.idempotencyKey = naive:<sessionId>`. Qualification, trace audit and report paths deliver their costs on each invocation/replay. The mapper now refuses unmeasured usage, missing/malformed external identity, non-session sources and invalid amounts before sink delivery. Measured zero remains valid. This input guard does not provide sink deduplication.
- `packages/core/src/evals/integration/services.ts` rejects costs without measured usage/session identity, checkpoints cost artifacts, then calls `ctx.recordCost`. Completed design/investigation replays redeliver the same evidence. Its comment explicitly requires atomic sink idempotency.
- `packages/core/src/evals/integration/services.test.ts` exercises a sink commit followed by lost acknowledgement. Its fake sink is a Map keyed by `meta.idempotencyKey`; the test proves replay delivery and no extra session dispatch, **not production SQL deduplication**.
- `apps/web/src/server/job-store.ts:recordCost` currently parses then unconditionally inserts into `schema.costs`. `makeServiceContext` delegates directly to it. `jobKnownCostMicroUsd` sums every row, so duplicate delivery increases reported spend and reduces remaining context budget.
- `packages/core/src/db/schema.ts:costs` has a UUID primary key and a nonunique job index. It has no receipt-key uniqueness constraint.
- `apps/web/src/server/sandbox/store.ts:addCost` inserts a cost then increments the suite/run aggregate in a separate statement. It also lacks keyed replay handling. Adoption there needs both deduplication and atomic insert/aggregate settlement.

**Activation gate:** the current application sinks do not satisfy the B replay contract. A successful real-method fixture or staged core test does not clear this gate.

## Proxy receipt adoption

The new `judges/naive-proxy.ts` emits `NaiveProxyCost` with source `naive_proxy`, the SDK request ID, provider `billed_micro_usd`, and `naive_proxy:<requestId>` replay identity. `contracts/index.ts` currently permits only `naive` and `ai_gateway`, so this receipt must **not** be cast into `ServiceContext.recordCost` or mislabeled as a session. Track A must extend the cost contract and keyed SQL sink for proxy receipts before application activation. Vendor cost/token counts are not customer-billed usage.

The proxy has no SDK money-cap field. `max_tokens` bounds output tokens, while `createNaiveProxyBudget` reserves against shared job and Jude-period SQL ledger scopes; measured overage remains recorded. A live model/input pricing envelope is an acceptance gate, not a provider hard-cap claim.

## Proposed owner implementation

1. Add an explicit nullable `receipt_key` column to costs. For Naïve session receipts, derive it in trusted code as `naive:<sessionId>` and verify supplied metadata agrees. Require a nonempty validated session identity, `measured:true`, and a nonnegative safe-integer micro-USD amount. Reject unknown usage as pending reconciliation; do not finalize it as a measured zero. A measured zero is valid.
2. Enforce database uniqueness for keyed receipts, independently of process lifetime. For the existing globally unique provider-session identity model, use a unique partial index over `(source, receipt_key)` where `receipt_key IS NOT NULL`. This intentionally makes attempted cross-job reuse conflict instead of charging the session twice. If provider IDs are only unique within an organization, add a **trusted configured provider-account scope** to the key/index first; never take that scope from model output.
3. On insert conflict, compare the persisted receipt with the proposed immutable accounting identity: source/account scope, job or sandbox owner identity, session/request ID, agent label, measured amount and canonical purpose. Return success only for an exact replay. Reject changed ownership, amount or identity as an accounting conflict requiring reconciliation. `ON CONFLICT DO NOTHING` alone hides conflicting receipts and is insufficient.
4. Perform the insertion and any aggregate increment or linked settlement in one transaction. Increment suite/run totals only when a new receipt row is inserted. A retry after a successful commit and lost acknowledgement must compare and return the retained receipt without incrementing totals. A failed transaction must leave neither half committed.
5. Preserve existing unkeyed gateway behavior until its own authoritative request identity is designed. Do not invent random replay keys or incorrectly dedupe distinct gateway calls. Future Naïve proxy costs use their provider `request_id` with a distinct source/key namespace (`naive_proxy`), not a session identity.
6. Keep the runner's durable reservation ledger authoritative. A cost receipt write is not a second reservation or permission to raise budgets. If a new integration also updates reservation state, include that transition in the same owner transaction or supply its own explicit durable reconciliation protocol.

Example schema shape for owner review (not a runnable migration against current data):

```sql
ALTER TABLE costs ADD COLUMN receipt_key text;
CREATE UNIQUE INDEX costs_provider_receipt_uq
  ON costs (source, receipt_key)
  WHERE receipt_key IS NOT NULL;
```

Before generating a migration, inventory existing keyed metadata and duplicated session receipts in staging. Identify exact duplicates versus conflicting amounts/owners; do not silently delete or sum them to make the index succeed. Define and retain an owner-approved reconciliation/backfill receipt. Validate the migration against the actual database schema and app callers. No production migration is authorized by this document alone.

## Required acceptance evidence

Run against PostgreSQL using the real owner sink and migration, not only a Map or mock:

- Two identical deliveries produce one row and one aggregate increment.
- Many concurrent identical deliveries, including separate processes, settle once.
- Commit succeeds but the caller loses acknowledgement; a fresh process replay succeeds with no extra charge.
- A conflicting amount, session identity, agent/purpose or job/sandbox owner under the same receipt key is rejected without changing the retained row or totals.
- A crash/error between attempted cost insertion and aggregate update rolls back both, then replay settles once.
- Missing session identity, negative/fractional/unsafe amounts and unmeasured usage cannot become finalized Naïve receipts; a measured zero can.
- Different sessions remain separately charged even when amounts and purposes match.
- Source/account namespaces remain isolated; cross-job session reuse is rejected under the global identity assumption.
- Current authorization resolves the owning job/sandbox before delivering or returning a retained receipt.
- A real service replay preserves `naive:<sessionId>`, recorded usage and remaining-budget arithmetic, with no additional provider session creation.

Capture applied migration identity, exact source commit, test database scope and results in `docs/naive-plan-progress.md`. Until then, label the sink requirement **unimplemented in the current app** and preserve lite/real evidence boundaries.
