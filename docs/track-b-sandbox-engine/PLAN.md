# Alex / Track B sandbox engine implementation

Source: origin/track-a commit aa94505, docs/SANDBOX_EVALS_PLAN.md and packages/core/src/sandbox/spec.ts. User requested beginning Alex's portion on November 7. Section14 names Track B as engine owner but retains Track A v0 implementation; this additive implementation avoids simultaneous writes to Track A's sandbox directory.

Ownership: Track B owns new packages/core/src/evals/sandbox/{generation,execution,grading}/ with focused tests and handoffs. Track A retains spec.ts, ingest, runtime/Neon isolation, microVMs, routes, reports UI, queues, payments and deployment. Shared spec is consumed unchanged from the pinned ref in isolated test staging; proposed contract amendments are documented, never silently applied.

Parallel work:
1. Generation and admission: policy-bound scenarios, actual oracle/null/mutation execution evidence, immutable approvals, existing Naive session/accounting reuse.
2. Execution and simulation: constrained user driver, secure tool loop, bounded deterministic trials, cleanup/recovery and media ports; capability gaps remain explicit.
3. Grading and statistics: state/trajectory/output/collateral/security/perception checks, diagnostic rubrics, repeat reliability and Wilson intervals, attribution and paired comparisons.

Integration: leaf modules import shared spec types only, not sibling implementations until parent integration. Each exports typed ports. Trial results cannot represent unknown cost or unresolved outcomes adequately; preserve rich metadata alongside legacy projections and refuse unsupported successful projection. oracleValidated alone is not trustworthy admission evidence. SQL and tool data are untrusted. Never execute customer SQL outside the supplied isolated runtime.

Validation: fixture controls must include oracle success, all three null agents failing, mutations that flip the relevant grader, separate trial state, indirect injection state failure, incomplete outcome exclusion, repeat/version identity, and secret/budget boundaries. Offline evidence is not live model or platform acceptance. No cloud mutation, provider spend or deployment is part of these assignments.

Follow-on: parent composes engine, calendar EnvironmentSpec bridge, approved-suite/remediation/progress/report integration; then bounded real runtime and voice/vision acceptance after concrete provider/cost configuration. Existing release and autonomy teams remain separate.
