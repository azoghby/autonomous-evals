# Current Track B adoption handoff

Updated November 7, 2026 after integrated sandbox security/stateful/media work and autonomous adoption artifacts. This index distinguishes deployable-source artifacts from verification and production acceptance. No production deployment is claimed.

## Text/Calendar application composition

The current consolidated owner patch is [track-b-judged-release/application.patch](track-b-judged-release/application.patch), targeting exact Track A `aa94505fd535f5c0f586cc6325b49b71a1683761`. Follow its [README](track-b-judged-release/README.md), migration identity aliases and [owner coordination](track-b-judged-release/OWNER-COORDINATION.md). Do not stack it over prior complete application patches. Reproduce its stager and compare every source byte before owner application.

Includes private chat, rich Text/Calendar Workflow, data admission/resumption, supported reviewed packs, secured remediation, judging, comparison/monitoring, finding reruns and the report snapshot fix. Child verification records 590 test executions (overlapping suites, not unique assertions), full core/app TypeScript and Next/Workflow build. Historical evidence and manifests retain their original pins.

This artifact's core snapshot predates the new sandbox engine and autonomous-company modules. Those are separate additions on main; applying a historical complete core overlay to a newer checkout must not silently remove them. Track A remains owner of actual application/platform adoption and migrations.

## Corrected live acceptance budget

The conditional immediate-completion path is **77 target / 50 Gateway / 10 paid Naïve HTTP operations**, not the older 77/48 estimate retained in the judged-release verification text. Approved ceilings remain **32 / 16 / 0**, with no cloud mutations and 180 seconds. The original plan command and metered extension now agree:

```sh
node tests/track-b/live-acceptance/provider/app-run.mjs --plan
node --test tests/track-b/live-acceptance/provider/app-run.test.mjs tests/track-b/metered-acceptance/meter.test.mjs
```

The second command passed 140 tests after the correction. The two extra Gateway calls are reproduction judgments; the ten Naïve operations are create/get for investigation, proposal and three summaries. Additional polling, recovery, revisions or absent retained design are outside this conditional envelope. Dollar bounds and elapsed feasibility remain unproven. Larger numeric caps alone never authorize live execution.

[Metered acceptance handoff](track-b-metered-acceptance/README.md) specifies durable dispatch admission, cancellation, genuine proposal requirements, independent replacement-hash approval and provider usage reconciliation. Same-endpoint prompt remediation still conflicts with v2's unequal target-version condition; Calendar cross-job suite identity also requires an explicit contract resolution. Preserve truthful identities rather than fabricate version changes. Hosted auth, SQL concurrency, migrations and actual private reports remain acceptance gates.

## Autonomous company addition

Core modules under `agents/autonomy` and `evals/data/autonomy` plus the [owner adapter](autonomous-company-integration/README.md) are on main (`b1d0265`). Parent re-ran 44 tests with strict transitive TypeScript against the current report renderer. Real local SQL and actual four-role services exercise intake, payment wait, independent data admission, twelve-case evaluation, publication and outbox without per-job founder intervention. Providers are scripted, not live.

Owner startup/cron/report-route mapping, authorized source permissions, genuine provider/receipt transports and hosted recovery remain required. The [autonomy adoption extension](autonomy-release-adoption/README.md) preserves newer Track A `875ceef` and includes authenticated server composition with local SQL/build evidence; owner route/cron registration remains required. The [shared paid reservation policy](autonomy-shared-accounting/README.md) has 48-test local verification. The [paid application extension](autonomy-paid-app-integration/README.md), integrated at `7c53392`, supplies guarded Text/judge/remediation/monitoring wiring with 113 offline tests, six SQL security checks and a historical-stage full build. Autonomous Calendar remains blocked on durable run identity. Current-main application reconciliation is in progress; the legacy judged patch does not silently enable this extension. Customer payment/clarification remains external input; unknown usage/permissions do not become successful evidence.

## Alex's sandbox engine

The shared contract and new plan are Track A `aa94505`, unchanged. Main now contains:

- [Input identity](track-b-sandbox-engine/identity.md): immutable normalized environment/scenario hashes and semantic reference validation; 12 focused tests.
- [Generation/admission](track-b-sandbox-engine/generation.md): actual oracle/null/mutation gate ports, provenance and exact approval; 22 focused tests.
- [Execution](track-b-sandbox-engine/execution.md): bounded isolated tool-loop runner, secure target and constrained simulator adapters; 21 focused tests.
- [Grading/statistics](track-b-sandbox-engine/grading.md): state/process/output/security/perception checks, unknown handling, Wilson intervals and version-matched comparison; 22 focused tests after parent snapshot fixes.

Engine [composition](track-b-sandbox-engine/integration.md), [stateful row authority](track-b-sandbox-engine/stateful-grading.md), [multimodal adapters](track-b-sandbox-engine/multimodal.md), and [security review plus fixes](track-b-sandbox-engine/security-review.md) are integrated. Parent verification passed 13 current-A integration, 29 stateful grading and 22 security tests. Runtime snapshot capture and media lifecycle/report composition are integrated as described below; durable report composition and generation continuation remain in progress. These leaf checks do not prove a complete sandbox evaluation or live media acceptance. Track A owns ingest, runtime/world provisioning, REST/MCP, microVMs, app UI and deployment. v1's table-only allowed changes cannot by itself prove a write touched only authorized rows; the engine must retain unknown outcomes until bound row-level evidence exists.

## Upstream merge and current integration evidence

Track A merged its application, runtime/media and separate `sandbox/engine` implementation into upstream main. Parent merge `27af220` preserved those files and all Track B `evals/sandbox` additions without conflicts. The current shared spec adds optional trusted mutation `exec`; it does not by itself wire the two engine implementations together. Parent reran 13 B integration tests against the exact current `27af220` spec and 48 autonomy tests against merged sources (autonomy harness retains its explicit `875ceef` service-contract pin); strict TypeScript passed for both scoped graphs. No full merged-app deployment acceptance is inferred.

The [runtime snapshot bridge](track-b-sandbox-engine/runtime-bridge.md) is integrated with 19 real SQL tests and a parent fix detaching execution evidence before asynchronous sealing. The [migration registry reconciler](release-registry-reconciliation/README.md) passed 49 tests after duplicate-JSON/UTF-8 hardening. It reads exports only and performs no DDL. Actual A `query` still drops positional parameters; the owner parameter patch remains necessary.

Media lifecycle is integrated at `74fab97` with 17 parent-verified tests against current A; [receipt admission](track-b-sandbox-engine/media-admission.md), integrated at `1b156b4`, adds independently authorized complete perception evidence and actual SQL proposal/gate acceptance. The child recorded 22 admission/media/integration, 29 grading and two Text regression tests. Missing proof stays unknown.

[PostgreSQL persistence](track-b-sandbox-engine/persistence.md) is integrated at `414eff5`, with child evidence of 14 native PostgreSQL tests including independent connections and restart. Parent rerun against media-integrated sources failed strict compilation because its harness staged only the A spec and omitted media modules/SDK dependencies; this is not a passing combined result. Dedicated work now covers strict media-report persistence, corrected original harness staging and actual engine replay. Repeated generation bindings currently remain unresolved; safe durable pending-agent continuation is a separate active implementation.

Parent `0398517` explicitly rejects IPv4 benchmarking `198.18.0.0/15` after root tests exposed an address-library classification gap. Both unchanged transport/source suites plus boundary cases passed: strict compilation and 101 tests using retained offline dependencies. The general target harness itself needs dependency staging maintenance; scoped evidence does not claim a root build.

Other active scopes cover customer-configured cost quality gates versus unknown billing telemetry, and current-main reconciliation of the paid autonomous application artifact. Hosted snapshot retention/reaping, authoritative settlement and live provider/authorization acceptance remain required.
