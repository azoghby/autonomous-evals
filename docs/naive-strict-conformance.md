# Strict Naïve conformance evidence

This executable scripts-layer gate strengthens the conformance portion of `NAIVE_PLAN.md` Phase 0. It does not close Phase 0 or activate any candidate, provider, deployment or migration.

The historical runner permits partial diagnostics: skipped checks do not change exit status, an empty run result can satisfy `every()`, and an empty investigation can report a passing rerun check without invoking rerun. `scripts/conformance.ts --strict` wraps the services and validates both check coverage and observed suite-pipeline execution. Non-strict diagnostic behavior remains available.

Strict execution requires complete target scenario coverage with matching suite/version/job identity and retained real run results for investigation. Actual successful rerun invocation is required. Missing, skipped, duplicated or unexpected check identities cannot count as complete conformance. CLI validation precedes service loading or fixture creation; suite pipeline checks share one fixture job so durable suite authority is not broken by the harness itself.

The gate observes calls to the selected implementation; it cannot prove that implementation used a particular provider or avoided internal fallback. The CLI still imports the direct core service seam. Existing incomplete methods must fail until implemented and mounted. Application routing, approved scope, live provider behavior, current resource pins, migration state, cost persistence and hosted restart/cancellation need their own evidence. The existing spend meter reports usage and is not an aggregate authorization cap.

No live conformance execution is part of this change. Offline tests use fixture services and are evidence of gate behavior only. Live runs require the separately reviewed staging/spend plan and privately supplied credentials. The full Naïve plan remains active.

## Verification

Actual-source suite: **4,152 passed, zero failures, two documented skips**. All 36 focused gate/options tests pass, including a rerun after the final static CLI error-message refinement. Required web TypeScript and explicit standalone script TypeScript pass. The actual CLI rejects `--strict --services lite` with exit 2 before service loading. Independent Sol review found no blockers. See [machine-readable receipt](naive-strict-conformance-verification.json) for source hashes and limits. No application build was repeated for these scripts-only changes; the approved39 application build remains its separate receipt.
