# Track B pricing contract alignment

Track A revision `ab3044635a924611fc76c4dee5de3c1718cc3ad5` changed Quick eval prices to $49 Trace Audit, $99 Text Eval, $199 Workflow Eval and $299 Version Comparison. Track B's independently copied $5/$10 menu was stale.

`evals/pricing.ts` now derives prices from `contracts.PRICE_CENTS` and `MONITORING_PRICE_CENTS_MONTHLY`. Commercial quotes, the agent menu, price validation and newly rendered reports therefore share checkout's constants. The obsolete pilot-pricing label is removed. Existing execution budget caps remain unchanged; a higher customer price does not authorize higher provider spending.

This covers Quick eval offers and the existing monitoring offer only. Subscription plan entitlements, per-finding caps, verified payment receipts and canonical startup remain application-owned. Historical stored quotes/reports are not rewritten. Resume identity checks still apply when the changed menu changes a provider request.

Regression checks cover the new approved amounts, rejection of old $5/$10 amounts, the $299 comparison quote, revenue/fixture labeling, draft-only outreach and rendered report prices. Full current-contract harness verification is recorded after execution; hosted billing is not established by these tests.

Parent validation against the merged local contracts: strict TypeScript and **280 tests across 15 agent/reporting files passed**, none skipped. Command:

```sh
node tests/track-b/run-checks.mjs --components agents,reporting --dependency-dir /tmp/sandbox-generation-deps.cBCEai/node_modules --dependency-fallback-dir /tmp/workflow-bootstrap.JpxCTM/node_modules
```

The full pinned-contract harness was also started separately and remains pending at this checkpoint; the focused result does not certify the full application or subscription billing.
