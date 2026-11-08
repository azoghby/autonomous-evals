# Stateful row grading extension

Owned changes are restricted to `packages/core/src/evals/sandbox/grading/`, `tests/track-b/sandbox-grading/`, and this new handoff. No Track A runtime, app, platform, shared spec, manifests, historical artifacts or sibling sources changed. Two native children supplied SQL controls and an independent authority review; ECC was disabled. Baseline plan/spec: `aa94505fd535f5c0f586cc6325b49b71a1683761`. Also inspected exact runtime README, `world-sql.ts` and `run.ts` at `36b1f72`, and compatibility handoff at `f02caf0`. The supplied remote ref `origin/track-a875ceef` was unavailable locally; the exact local commits were available.

## Narrow authority contract

`gradeSandbox` now accepts optional trusted server evidence:

- `rowAuthority: {runId, scenarioHash, envHash, suiteHash, snapshotId, allowed}`. `allowed` is a list of exact row predicates expressed as complete `RowMutation` records: `{table_name, pk, change, before, after}`. `change` is `inserted | updated | deleted`; before/after have the matching null/object shapes. Updates must actually change the row. Primary-key fields must agree with every present row image. The runtime’s synthetic `{_row:md5,_n:positiveOccurrence}` keys are recognized separately; upstream relation provenance must attest synthetic key issuance. Sparse arrays and non-JSON values are malformed. `pk` is a nonempty JSON object supporting both primary and synthetic runtime keys. Exact equality covers every field, including full before/after values and the key; JSON object order is immaterial. Grants permit changes; they do not require them. Required changes remain separate state/expected predicates.
- `rowDiff: {runId, snapshotId, allRows:true, relation:'sandbox_diff'}` attests the runtime relation is complete.
- `completeDiff.snapshotId` anchors both ports to the same immutable final snapshot as the complete summary. Missing anchor remains unknown for writeful grading.

Use exported `hashGradingScenario(normalizedScenario)` to bind the entire admitted scenario, not its ID. Environment/suite hashes must exactly match grading versions. Run and snapshot identities must agree across all evidence. These ports are approved server dependencies, never customer/model/tool JSON, prompt text, or copied final-state observations. Approval must be independently derived from reviewed policy and expected authorized rows, never by authorizing whatever the actual agent happened to change. Hashes/types/IDs are consistency checks, not authentication of an untrusted adapter.

The grader executes only this fixed row query through the captured read-only runtime:

```sql
SELECT table_name, pk, change, "before", "after" FROM sandbox_diff
```

No authorization SQL is accepted, no row values are interpolated, and no positional parameters are used. Arbitrary customer/model `SELECT true AS ok` can satisfy its own state assertion but cannot establish collateral authority. Every returned row must be a valid exact mutation. Duplicate table/key identities, malformed results, query errors, and any per-table/per-operation count mismatch with `diff()` make collateral unknown. Exact matching against approved mutations then passes or fails collateral. Counts include every table in the complete summary. Actual outside-table writes retain immediate fail precedence even when row authority is absent.

The runtime must bind query and summary to one frozen, quiescent snapshot and refresh/capture the complete relation before disposal. Matching count totals cannot independently detect a dishonest or same-count stale adapter; immutable snapshot provenance is essential. The current runtime caps query exports at 5000 rows. Truncated exports fail count reconciliation and stay unknown; this extension deliberately does not introduce pagination or interpolate grants into SQL to bypass that cap. Track A's complete relation includes non-sandbox user-schema tables with qualified names; five-row summary samples are never used as proof. `sandbox_outbox` remains outside that relation and requires existing dedicated approved security predicates; this extension does not attest outbox safety.

## Process compatibility and preserved controls

`before` checks now reject `executed:false`, errors, and pre-execution `http_500`, `timeout`, or `rate_limited` faults as successful prerequisites, even if another signal is absent or spoofed. Older records with absent `executed` retain compatibility only through existing error/fault signals; absence is not a new execution attestation. Called/count rules still count attempts. The inspected A runtime does not currently assign `executed` to records: owner wiring and tests remain required. Its query method also forwards an empty parameter list despite the newer optional-params spec; this implementation does not rely on that broken forwarding.

Scenario/versions/transcript/evidence snapshotting before async reads, secret-free error details, rubric calibration, perception/security evidence, unknown-cost projection refusal, and statistical exclusions remain in force. Row authority resolves collateral only: it cannot establish oracle validation, suite admission, security exposure, actual costs or production acceptance.

## Integration and gate bridge follow-up (no sibling edits)

`GradingEvidence` is derived from `GradeInput`, so gate evidence and final snapshot ports can structurally carry the optional fields. `gradeSandboxGate` already forwards them and `bridgeGateGrade` preserves the existing `collateral` ID. No alternate check ID or model-boolean bridge is needed.

The owner must provide independently approved grants and complete immutable snapshot attestations through both gate and trial authority ports. Gate mutations require fresh run/snapshot binding. Candidate gate suite hashes and admitted full-suite hashes differ: rebind independently reviewed policy for the exact phase; never reuse a candidate receipt unchanged. Add sibling integration tests showing authorized oracle collateral pass with `complete:true`, same-table mutation collateral fail with `complete:true`, and missing/stale/malformed row evidence with `complete:false` even alongside another known failure. Update integration/grading handoff text that previously said every write stays unknown. This document supersedes that limitation only when all new trusted evidence exists.

Remaining gates: immutable pre-disposal snapshots and recovery/reaper; production read-only SQL/isolation and complete relation provenance; runtime executed flag assignment and query-param forwarding fixes/evidence; exact approved row policy issuance/admission; aggregate or reviewed pagination support for >5000 rows; outbox/action security coverage; durable private report and approval storage; actual settled cost/budgets, attribution and live provider/media acceptance. No cloud/provider operations, secrets, spend, migration, deployment, sends or push occurred.

## Exact offline verification

Existing dependencies outside Documents were reused; no installs:

```sh
SANDBOX_GRADING_NODE_MODULES=/tmp/sandbox-generation-deps.cBCEai/node_modules node tests/track-b/sandbox-grading/run.mjs
TRACK_A_REF=875ceef SANDBOX_GRADING_NODE_MODULES=/tmp/sandbox-generation-deps.cBCEai/node_modules node tests/track-b/sandbox-grading/run.mjs
```

Both commands strict-compile and run 29 tests (zero failed/skipped/cancelled/todo) against the exact unchanged selected spec. Default remains pinned aa94505 (SHA256 `71ae878f2fd00fb71a82a1310afeee1c490c7cade6cddb903e19bb2dbb147ffe`); compatibility stages 875ceef (SHA256 `4177bc33e564080fc19ae6174e8efbbddaf6fb2a4889238f047430276b68ec74`). New PGlite PostgreSQL checks exercise real read-only transactions/timeout setup; mutation/CTE/stacked-query rejection; authorized update/insert/delete; same-table unauthorized writes; wrong amount and wrong-row deletion; collateral beyond five sampled rows; arbitrary boolean SQL insufficiency; absent, stale, duplicate, truncated and malformed evidence. SQL worlds construct the documented diff relation from actual before/after state; they do not execute Track A's runtime or establish live Neon acceptance.

Additional regression validation: the independent review found primary-key/image inconsistency and sparse-array canonicalization gaps; both were corrected and added to malformed-proof controls. Existing integration smoke tests also passed against the pinned spec:

```sh
TRACK_B_NODE_MODULES=/tmp/sandbox-generation-deps.cBCEai/node_modules node tests/track-b/sandbox-integration/run.mjs
```

This strict-compiles and passes 13 existing offline tests, zero skipped. An additional invocation with TRACK_A_REF=875ceef also passed, but inspection confirmed this checkout’s integration runner ignores that variable and still stages aa94505; no newer-spec integration validation is claimed here. Parent f02caf0 separately records its newer-spec integration compatibility result. They remain smoke checks, not the new writeful bridge acceptance tests requested above. Inspected parent parameter-forwarding owner patch at `7a561dc:docs/track-b-runtime-parameter-fix/parameters.patch`; it was not applied or needed by this fixed-query extension. No hosted application is claimed.
