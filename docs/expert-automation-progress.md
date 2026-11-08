# Automated expert data acquisition

## Owner policy selected in this session

Alex requested end-to-end expert acquisition automation and selected automatic contact for opted-in experts, with approval for new cold contacts. He delegated the honorarium limit choice. Pilot policy: $25 per evaluation and $50 company-wide per day, reserved before any promise or invitation. These are expert-honorarium limits, separate from Naïve model budgets. Actual payouts remain manual until a payment integration exists. No invitations, commitments or payments have been made by this implementation work.

This updates the older blanket first-contact approval rule in EXPERT_NETWORK.md for opted-in experts only. New researched contacts still require approval. Customer material requires current customer sharing consent; without it, invitations/questions use only a trusted generic subject. A model cannot grant contact consent, approve its own answers or increase caps.

## Current implementation boundary

- `evals/data/acquisition.ts` assesses coverage, source permissions and answer verification; tries discovery, generation and expert acquisition. Missing evidence stays pending/inconclusive. Synthetic answers do not become ground truth merely because a model produced them.
- `evals/data/expert.ts` checks expert qualification, informed data-use consent, independence and the exact contribution/review snapshot. The acquisition review and quality gate still decide whether the corpus is sufficient.
- `evals/data/adapters/automated-expert.ts` adds bounded resumable orchestration: current policy, durable request identity, qualified contact selection, shared budget reservation, invitation intent, delivery reconciliation and contribution polling. Ambiguous delivery does not authorize a resend. Returned contributions remain candidates for the independent review/quality boundary.
- `evals/data/adapters/postgres-expert-loop.ts` provides real transaction-authorized SQL state/CAS plus shared-ledger honorarium promises. It reuses the existing text checkpoint schema and separates expert budget scopes from inference caps. The owner must retain the first promise day on replay; unresolved commitments are never automatically released.
- Existing application expert requests, engagements, questionnaire pages and response storage are implemented in `apps/web/src/server/experts.ts` and operator/expert routes. The existing invitation function always creates a pending approval draft; it is not yet the automated owner's implementation.

## Required owner integration for actual automation

1. Bind the adapter to canonical job/customer/task authority and the selected standing policy, rechecking consent, suppression, opt-out and limits on replay and before sending.
2. Connect durable request identity to existing expert requests. Select opted-in qualified experts from the private pool; route researched cold candidates through the existing approval queue.
3. Reserve honorarium commitments atomically against both job and shared daily limits before preparing an invitation that promises payment. Persist outstanding commitments across day changes, retries and response delays.
4. Connect invitation intents to the existing private questionnaire/draft records and durable email dispatch. Reconcile ambiguous provider sends by retained receipt; never use a timeout as permission to resend.
5. Convert submitted answers into provenance-bearing candidate cases with source/use permissions. Obtain authenticated independent review for exact answers; receipt of a questionnaire alone is not factual verification.
6. Resume the existing acquisition/evaluation Workflow on response or bounded scheduled polling. Retain pending states when no expert responds or quality remains insufficient; report that state to the customer.
7. Verify the mounted flow in staging: no duplicate invitations/commitments under retries, opt-out/revocation enforcement, approved response ingestion, and evaluation resumption only after the quality gate. Capture live send/response evidence separately from fake-transport integration tests.

The new core adapter does not by itself prove application wiring, deployed automation, real expert responses, or automatic payouts. Historical owner patches are not a substitute for adoption against current application source.

## Validation checkpoint

Parent combined agents/evals/judges: strict TypeScript and 940 tests across 63 files, none skipped. Tests include actual acquisition-to-ready with authenticated independent review and SQL restart after lost send acknowledgement; email/owner transports are simulated. This does not establish hosted delivery, real experts or end-to-end app activation.
