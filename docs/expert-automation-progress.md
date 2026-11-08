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

## Response and owner-bridge checkpoint

`expert-response.ts` now runs bounded Ines extraction from actual questionnaire records and maps only exact UTF-16 answer spans to candidate cases. Owner-issued request/engagement/response identity, qualifications, use consent and source permissions are required before spending. Missing metadata remains pending; the extractor cannot approve facts. Independent review is still separate.

The current-base [owner bridge artifact](expert-automation-integration/README.md) connects real SQL expert requests/profiles/private questionnaire engagements and founder drafts to the core adapter. Shared honorarium reservation and promise binding are transactional; sends have durable claims and ambiguous recovery is read-only. The SQL response reader retains first response identity and rechecks current grants/authorization/secrets after model and cost awaits. This is an unapplied owner patch, not mounted app code.

`advanceDataOrchestration` now has an explicit `resumeExpert` port for this durable provider state machine. Without it, legacy pending effects remain fenced. With it, a later Workflow invocation can advance selection, reservation and response polling without repeating an ambiguous send. The default behavior does not change for stateless providers.

Parent checks: strict combined agents/evals/judges **956 tests / 65 files**, none skipped. Independent reproduction of the applied owner bridge: **28 SQL tests**, focused strict types, four postimages and separately pinned B support verified. Eight original legacy approval assertions pass with a documented fixture for the new SQL routing boundary; unchanged old fixtures alone have six missing-boundary failures. Provider/email transports and extraction runner are fakes; hosted contention, real email, automatic response review and Workflow mounting remain unverified.

Both `18527a1` CI repair and `eaf7f69` implementation passed complete GitHub CI (web/core types, unit tests and production build). These results predate this checkpoint's uncommitted additions; they are not deployment evidence.

## Approved application source adoption

Alex approved the reviewed combined 15-file patch. The concrete accounting/expert SQL adapters, managed founder approval routing, response reader, cost contract/sinks and coherent 0023/0024 migrations are now applied to actual application source and hash-verified. The older standalone owner patches remain historical artifacts. No live migration or deployment was performed, so production behavior is not changed by this source adoption.

Parent independently reproduced 52 SQL tests plus 8 original outreach tests on the exact adopted source. Full core types and schema/snapshot coherence passed; supplementary web types/webpack build passed using a documented temporary analytics-version substitution, so that build is not exact dependency evidence.

Core `resumeGeneration` and `resumeFreeze` now opt into durable same-session reconciliation; legacy providers remain fenced. Final combined strict agents/evals/judges check passed 959 tests / 66 files with no skips.

The separate [Workflow gate artifact](expert-workflow-integration/README.md) is **not applied**. Its actual job Workflow fixtures pass 12 tests and six staged postimages are hash-verified. It includes seven-day durable polling, cancellation events, canonical plan/secret rechecks and real-mode enforcement. It still holds reviewed frozen data for the missing rich execution consumer. Canonical plan/grant/review provisioning, Workflow source adoption, 0025 registration, rich execution, hosted acceptance and live migrations remain open.
