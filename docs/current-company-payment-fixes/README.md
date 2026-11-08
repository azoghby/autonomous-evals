# Payment revocation and receipt-queue corrections

This is an additive owner-application correction to the historical combined company candidate, not a deployment. No actual Track A application source or historical artifact is edited. `PIN.json` binds all four application preimages/postimages and the owner patch; the separate SQL addition must follow `001-current-payment.sql` under the owner's migration registry/grants.

The independent review `8756a5a` reproduced two Medium defects. First, refunded/cancelled rows permanently occupied the bounded receipt drain. Second, a durable refund between two paid calls did not stop the second call.

## Corrections

- The bounded retirement function acknowledges only irreversible refund/cancel, revoked-binding, terminal-job or superseded-quote events. It retains their immutable events and receipts; it never creates payment authority.
- The scheduler retires at most 1,000 rows per pass, then selects up to 25 jobs by oldest attempt. Blocked work gets a monotonic attempt marker before retry, so it cannot permanently monopolize lexical slots. Unknown/transient failures remain pending.
- Canonical startup supplies a current payment check to the paid guard. A prepared quote without a receipt can still qualify, but a revoked binding or invalid retained receipt blocks further paid dispatch. Customer job/request authority is rechecked around that lookup.
- Cost reconciliation uses the existing owner/job/policy guard and authenticated receipt verifier, without requiring renewed permission to spend. A refund cannot erase an existing cost or authorize a new request. Revoked owner/job authority still refuses reconciliation.

The optional release hook preserves legacy factory compatibility; the corrected canonical startup always supplies it and excludes caller overrides from its owner configuration type. Direct custom release construction remains responsible for supplying its own current payment authority.

## Verification and adoption

`node tests/track-b/current-company-payment-fixes/run.mjs --typecheck --baseline` verifies every historical input hash, creates a disposable copy, applies the pinned correction and separate SQL addition, and runs the original review and baseline suites plus the refund/reconciliation regression. No providers, secrets, hosted database or cloud migration are used.

The three previously failing reviewer reproducers are retained. Assertions that deliberately pinned wrong queue counts are converted to corrected counts in disposable staging only; original review artifacts remain unchanged. Real Calendar identity, SQL-port, revocation and replay tests remain included. The docs bridge postimage is staged byte-identically to the corrected application bridge so its tests exercise the same code.

Final verification passed strict TypeScript and all 222 tests across 36 files, including the explicit regression that prior costs reconcile after refund without permitting another dispatch. The run exited 0 with no skipped tests; its output is retained in `verification.log`. Current-main adoption, migration registration/grants, hosted contention/recovery and genuine billing remain separate gates. The historical candidate uses its historical prices; the independently committed current price fix must be preserved when adopting onto current main.

## Temporary-authorization queue fairness

A supplemental SQL regression passed after the 222-test run: with a frozen clock, 25 unauthorized but otherwise valid pending payments rotate behind an unattempted healthy payment on the next tick. None are retired merely for failed authorization. Restoring authorization drains all 25 and preserves exactly 26 receipts in total.

Command: `node tests/track-b/current-company-payment-fixes/run.mjs --typecheck receipt-fairness`. Strict TypeScript and the one focused test passed, no skips. Exact output: `fairness-verification.log`. This adds evidence without changing the production correction or its pinned hashes.
