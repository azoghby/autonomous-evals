# Reviewed appended-pack integration

This additive module is exported from `packages/core/src/evals/packs/index.ts`.
It does not modify the text engine, shared contracts, Workflow, reporting,
monitoring, remediation, application or platform. It is an integration handoff,
not evidence of deployed product completion.

## Inspected boundaries

Read-only local `origin/track-a` inspection used commit
`f0068733ca49c37f40fd7de279325f21a4b5fbbb`, specifically
`redteam/{select,types,library,grade}.ts`, `contracts/index.ts` and
`apps/web/src/workflows/steps/evaluate.ts`. `fromScenario` resolves `rt_*` IDs
from the trusted built-in library and ignores stored check specs. Shared Suite
allows 32 scenarios. Workflow enables appending by default, with
`REDTEAM_PACK=0|false|off|no` disabling it; append skips existing IDs and validates
the final Suite. It does not truncate an overflowing suite.

Track B still requires exactly 12 scenarios with `S01..S12` IDs and preserves its
existing hash/admission code unchanged. This module verifies that admitted base
and stores its digest separately. It never inserts `rt_*` scenarios into the
historical frozen body or weakens objective/rubric admission to make them fit.
Existing remediation verifies only the original 12 scenarios; its result cannot
claim an appended pack passed. Existing monitoring/comparison must receive
separate pack evidence through the handoff below.

## Accepted types and explicit quarantine

Manifest format: `appended_pack.v1`; execution evidence: `appended_pack_run.v1`;
runner capability: `secured_pack_runner.v1`.

The only accepted semantic type is `redteam.literal_response.v1`: one user turn,
no injection, plant, rubric or tool requirements, with nonempty literal
`not_contains` rules, no regex patterns and `includeToolArgs=false`. It retains
the source `leading`/`anywhere` mode. At the inspected revision, the exact accepted
IDs are `rt_inj_direct_fake_system` and `rt_jb_dev_mode`.

Execution additionally requires an exact pinned Track A grader adapter. Its
literal rules include base64 and separator-obfuscation behavior; substituting
the text engine's substring evaluator would weaken the criteria. The new runner
therefore reuses the secured `TextTargetPort` and delegates grading to that
trusted code port. It implements neither a new HTTP client nor another grading
engine. Objective/judge implementations are not duplicated. Rubrics, refusal,
safe completion, compliance, tool calls, multi-turn conversations, planted
prompts, document/tool-output injection, and pattern rules are quarantined in
v1. Adding support requires a separately reviewed semantic contract and the
corresponding secured runner, durable target/judge fencing and tests.

Unknown `rt_*` IDs are quarantined as `unknown_trusted_id`. Known unsupported
specs retain their full trusted spec and digest with `unsupported_pack_semantics`.
An unavailable runner/grader produces a persisted runtime quarantine before any
target send. No quarantine counts as a pass. Inventory accepts 1–20 unique
appended IDs (12 + 20 = shared max 32); overflow/duplicates reject explicitly.

## Composition and trust ports

1. Construct `createTrustedRegistry` from the reviewed, pinned, code-owned
   library. Retain prior registries for historical artifacts. Never construct it
   from intake or stored `Scenario.checks[].spec`. Its SHA/path/data validation
   and library digest establish identity, not authority to nominate trusted code.
2. Authorize the job and source rules at the server composition root. Compute
   `actualPackTargetDigest` from the actual resolved endpoint, model,
   configuration version and system prompt; configurationVersion must change
   for relevant transport/tool/settings/credential-reference changes. Credentials
   stay in the secured target closure; do not place their values in identity data.
3. Build a draft containing `packId`, `version`, `baseDigest`, the complete
   ordered `scenarioIds`, and authorization `{authorizationId, sourceRuleIds,
   targetConfigDigest}`. `packReviewDigest(draft, registry)` is the review target.
   Obtain an authenticated reviewer receipt `{reviewerId, reviewedAt,
   contentDigest}` before `freezePack`. Receipt/authorization IDs are references
   to authoritative server records, not self-issued intake strings. This module
   verifies content binding; the composition root verifies issuer authority.
4. Construct `createSecuredTextPackRunner({target, configuration, registry,
   grader, knownSecrets})`. The target must be the existing secured target
   client. The grader binds the identical registry provenance and implements
   `gradeRule(spec, index, response)` using the pinned Track A `gradeRedTeam`
   with exactly that single source rule. Never deserialize executable code.
   The offline secured-port tests demonstrate this adapter with actual source.
5. Construct `createPackExecutionService({checkpoints, registry, runner,
   resolve, verifyReview})`. `resolve(jobId)` must authenticate the current caller on every
   run/report and return the authorized job/environment, authorization ID,
   source-rule IDs and actual target configuration digest. It must not trust a
   caller-selected job ID alone. The required `verifyReview(manifest, context)`
   must authenticate the reviewer receipt and source-rule authorization against
   authoritative server records on every run and report, throwing on denial.
   Use the existing `PostgresTextCheckpointStore`
   and existing `text_integration` migration; no new database engine/schema.

The manifest binds review, provenance, full ordered inventory, per-spec digests,
base digest and authorization/configuration. Runtime objects are deeply frozen.
Strict stored schemas and reconstruction from the trusted registry reject forged
specs even when a caller recomputes hashes. Hashes are integrity checks, not
signatures or access-control proofs.

## Workflow team handoff (`docs/workflow-integration`)

Use the clean exports above; application changes belong to the Workflow team.
After the existing append selection, preserve **every** appended ID in the
reviewed manifest using `draftFromAppendedInventory({draft, baseScenarioIds,
sharedScenarioIds})`. It rejects missing/reordered base IDs, extra non-pack IDs,
duplicates and overflow; it captures all `rt_*` IDs. Freeze/persist the admitted base12 independently. Do not feed
the enlarged shared Suite into text admission, strip extra cases, or treat an
empty findings list as complete assessment.

Call `service.run({runId, manifest, baseSuite, baseRun})` with a stable run ID and
the complete existing base `SuiteRun` (or explicit null for unknown base status).
The service commits full manifest/base/context evidence before claiming any pack
dispatch. A changed manifest/base/run/configuration/authorization under the same
identity conflicts. A changed version needs a new reviewed manifest and run ID.
Pending or ambiguous dispatches never expire or retry; operator reconciliation
is required. A new adapter over the same SQL store resumes completed results.
The whole supported case is one fenced target dispatch; v1 does not launch judge
calls. No process restart may replace an unresolved run ID to bypass its fence.

`service.report(jobId, runId)` reconstructs complete expected inventory from
durable checkpoints without needing a supplied manifest or performing dispatch.
Persist/export that full evidence, including `base` and `pack` separately.
Statuses retain `unknown`, `not_assessed`, `infrastructure_error`, `quarantined`,
`concern`, `fail`, and `pass`. Aggregate precedence keeps failures visible;
individual results retain simultaneous coverage gaps. A base pass says nothing
about pack status. Missing evidence is unknown, never success.

`comparePackRuns(left, right, registry)` retains the union of expected IDs and
only pairs complete assessed cases under matching base/spec/source-rule criteria
and trusted provenance. Different target configurations are explicit run evidence
for version comparison. Missing/changed/unassessed cases remain unpaired with
reasons. Select the historical pinned registry explicitly; a new registry cannot
silently reinterpret old manifests. This function returns case pairs, not a
statistical significance claim. Only compare evidence retrieved from authorized
durable reports. Do not pass this result through boolean-only legacy converters.

Remediation handoff: retain the original base and manifest, authorize each
actual patched target configuration, obtain a new review for its bound manifest,
and execute fresh cases under a new run ID. Until Workflow/report/remediation
wiring carries both scopes, label existing verification as base12 only.

## Offline acceptance and remaining blocks

Run with already-installed local dependencies:

```sh
PACK_TEST_DEPENDENCIES=/absolute/path/to/node_modules node tests/track-b/pack-integration/run.mjs
```

The harness stages source to a disposable directory, reads actual trusted
Track A library/grader/contracts from the exact local ref, type-checks the new
module strictly, and runs pack tests plus existing admission/checkpoint tests.
It never fetches, installs packages or accesses providers. SQL tests execute the
real checkpoint migration and adapter on PGlite PostgreSQL, exercising restart,
content conflicts, pending/ambiguous fencing, full manifest persistence,
independent scopes and comparison. This is not a deployed multi-worker database
or live-provider acceptance claim.

Validated locally on 2026-11-07 against the pinned revision above: strict
TypeScript passed; 6 test files / 90 tests passed (20 new pack tests, including
10 SQL execution tests, plus 70 existing admission/checkpoint tests). No tests
were skipped. Existing frozen12 implementation files were unchanged.

Remaining integration blocks: authenticated review/source-rule record issuance,
production trusted registry/grader composition, actual configuration/version
resolution, durable application migration deployment, Workflow adapters,
authorized artifact/report delivery, monitoring/remediation propagation, and
semantics quarantined above. No app/contracts/platform changes or cloud calls
are included in this workstream.
