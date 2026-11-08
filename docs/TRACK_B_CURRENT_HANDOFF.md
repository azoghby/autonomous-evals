# Current Track B adoption handoff

Updated November 7, 2026 after integration of the judged-release artifact (`b8cce34`) and acceptance-plan correction (`9b61183`). This index distinguishes deployable-source artifacts from verification and production acceptance. No production deployment is claimed.

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

Owner startup/cron/report-route mapping, authorized source permissions, genuine provider/receipt transports and hosted recovery remain required. Autonomous app adoption is a separate extension in progress; the legacy judged patch does not claim to enable it. Customer payment/clarification remains external input; unknown usage/permissions do not become successful evidence.

## Alex's sandbox engine

The shared contract and new plan are Track A `aa94505`, unchanged. Main now contains:

- [Input identity](track-b-sandbox-engine/identity.md): immutable normalized environment/scenario hashes and semantic reference validation; 12 focused tests.
- [Generation/admission](track-b-sandbox-engine/generation.md): actual oracle/null/mutation gate ports, provenance and exact approval; 22 focused tests.
- [Execution](track-b-sandbox-engine/execution.md): bounded isolated tool-loop runner, secure target and constrained simulator adapters; 21 focused tests.
- [Grading/statistics](track-b-sandbox-engine/grading.md): state/process/output/security/perception checks, unknown handling, Wilson intervals and version-matched comparison; 22 focused tests after parent snapshot fixes.

Composition, stateful row-level collateral evidence, multimodal adapters and independent security review are in progress. These leaf checks do not prove a complete sandbox evaluation or live media acceptance. Track A owns ingest, runtime/world provisioning, REST/MCP, microVMs, app UI and deployment. v1's table-only allowed changes cannot by itself prove a write touched only authorized rows; the engine must retain unknown outcomes until bound row-level evidence exists.
