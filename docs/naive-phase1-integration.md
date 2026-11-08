# Naïve Phase 1 integration seams

`docs/NAIVE_PLAN.md` remains the migration roadmap. This document records current reusable core seams and owner integration requirements; it does not certify application adoption, hosted execution or full Phase 1 completion.

## Remediation: reuse the existing contract wrapper

`packages/core/src/evals/remediation/index.ts:createRemediationServices` already returns both `proposeAndVerifyFixDetailed` and an `EvalServices['proposeAndVerifyFix']` wrapper. A second adapter would duplicate this seam. The wrapper passes **only `input.finding.id` as a lookup hint** to the detailed engine and returns its contract remediation unchanged.

Caller-supplied finding prose, status, suite and intake are intentionally ignored. They neither authorize work nor select a baseline, target, patch trial or grading criteria. This is canonical lookup semantics, not strict byte-equality validation of a stale request. The detailed engine calls `deps.resolve(ctx, findingId)` on every invocation, including completed replay. It then checks job/environment/finding identity, confirmed status, current secret policy and stored baseline association.

The Track A composition must provide these real ports:

- `runner`: durable Naïve session runner with the pinned role configuration and budget ledger.
- `checkpoints`: the current PostgreSQL `TextCheckpointStore`, with the Phase 1 text checkpoint migration applied through the owner process.
- `resolve`: current caller/job ownership authorization; canonical stored finding; current secrets; exact target/version/environment; the original admitted frozen suite and full baseline run; original failing objective-check IDs bound to finding evidence.
- `trial`: either null or a secured fresh isolated target port. Its receipt must prove the actual applied configuration and exact trial/baseline/suite/run/scenario/patch identity. Do not echo a requested patch as if it were proof of application. Never mutate deployed customer configuration.
- `judge` and `authorize`: explicit secured judging and atomic operation-budget authorization. No invented reservations or free target usage.
- `ctx.recordCost`: atomic receipt settlement as specified in `docs/naive-cost-settlement-handoff.md`. Repeated delivery is required; a mock sink is not production accounting evidence.

Trace-only inputs without an isolated executable baseline remain **`not_verified` proposals**, with zero before/after executions. Unsupported patch types also remain proposals. Fresh objective checks, regressions, complete scenario coverage and original frozen criteria determine verification; an agent's claim cannot promote the status.

New patch proposals now use Ines (`quality_investigator`) as required by the plan, with a durable proposal-role pin. Completed historical engineer proposals and their accounting evidence replay unchanged; they are never relabeled. Legacy incomplete proposals without a role pin are blocked for reconciliation rather than dispatched again under a new task identity. The historical budget checkpoint key remains unchanged for recovery compatibility. A crash before writing the new role pin can also require reconciliation; it cannot trigger blind repeat spend.

## Existing implementation evidence versus application adoption

The engine's existing `remediation/remediation.test.ts` exercises SQL-backed replay, actual offline isolated target execution, unsupported changes, regressions, ambiguous target dispatch, measured-cost replay and forged request prose. New `evals/naive-remediation-service.test.ts` exercises the exported contract wrapper itself:

- Canonical stored facts win over a forged request suite/intake, with no historical-trace verification claim.
- A different lookup ID is refused before provider spend.
- Current authorization revocation prevents publication of a retained result.
- Newly sensitive content is screened again before publishing a retained patch.
- Lost cost acknowledgement replays identical measured evidence without another proposal session.

These are offline core tests, not actual application routing or provider acceptance. `packages/core/src/integration/compose.ts` is Track A-owned and must adopt the service through reviewed composition. Its historical comment claiming no remediation engine exists is stale relative to current core source. Do not infer that merging this document wires the method or disables lite fallback.

## Design and execution contract adapters

`evals/naive-design-service.ts` wraps rich design with the existing `EvalServices.designSuite` signature for text jobs. A current authorization port supplies canonical intake and a stable design slot; the durable admission port must retain the complete suite and supply its genuine approval artifact ID. The adapter does not manufacture an approval, checkpoint implementation, or target authorization. Completed replay still calls the durable rich engine for measured-cost redelivery, then rechecks current admission before publication.

`evals/naive-run-service.ts` wraps rich text execution with `EvalServices.runSuite`. The authorized resolver supplies immutable retained suite/scope, stable run identity and the canonical secured target transport. Request URL/key fields cannot choose a transport. Authorization is rechecked at dispatch and publication, and the canonical target key joins secret screening before checkpoint storage. The full rich run is persisted before projection; rubric/inconclusive/infrastructure states are retained then refused by the legacy boolean `RunResult` mapper.

These adapters are exported core implementations, **not composed app methods**. Owner ports must provide durable SQL admission/run storage and current ownership checks; the injected judge still needs the plan's Jude/Naïve implementation and measured-cost path. No test here proves every rubric call uses Naïve. Workflow/version-comparison mapping and rich assessment contract support remain separate work.

## Remaining acceptance

Complete the real-method composition and remaining role migrations, supply the secured owner ports, prove receipt deduplication against PostgreSQL, then run the plan's staging conformance and per-package acceptance with lite substitution disabled. Retain exact versions, session IDs and measured costs. Actual deployment and historical owner patches remain separate evidence states in the ledger and progress tracker.
