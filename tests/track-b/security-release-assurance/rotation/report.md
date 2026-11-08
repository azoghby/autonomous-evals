# Current-secret rotation assurance

Base/source reviewed: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`.
Local contract overlay: `8634ceb30f3d98de7ec24b240a4f7549dce80033`.
ECC disabled; this child did the work directly. Only this directory was written.

## Scope and result

**5 targeted tests pass: 2 acceptance cases and 3 explicitly labeled defect-characterization cases (two recovery modes for ROT-2).** Characterizations assert current unsafe behavior; they are not security acceptance and will need conversion after parent fixes. No skipped/todo/expected-failure tests. Strict TypeScript of the test and its imported dependency closure passes.

Inspected existing remediation review reports/tests, remediation target review, service-adapter report tests and resume-identity tests. Existing coverage addresses immediate secret-bearing proposals/responses, refreshed resolver policy, and changed-request identity. This slice adds composition across durable SQL/file restart boundaries with unchanged request identity, encoded opaque values, accounting replay and report consumption. It deliberately does not rerun the broad original fixture suites.

## Acceptance cases

- SQL-backed remediation proposal: initially admit a synthetic opaque value in patch rationale under an empty policy. Reconstruct the factory/checkpoint adapter; an unrelated current secret allows replay. After the rationale becomes a current secret, replay refuses with fixed `needs_operator` content error, without engineer rerun or checkpoint mutation. Uses real PGlite and the production checkpoint migration/adapter; SQL retains the old encoded artifact rather than rewriting evidence.
- File-backed report summary: use the real session service, report-summary policy and report adapter with an in-process fake provider. Persist the completed operator result, reopen `FileBackedPorts`, and construct a fresh session service/report service. An unrelated current secret allows reuse. Rotation to the stored summary value refuses report export, with no new provider create/get and no file mutation. This covers persisted provider output rather than a request-side limitation already tested upstream.

## ROT-1 — stored remediation cost metadata bypasses current policy before sink replay

Production location: `packages/core/src/evals/remediation/index.ts`, `record()` and the completed proposal branch. `record(proposal.costs)` runs before `safe(patch)` and never screens cost fields. `toContractCost()` copies purpose into `meta.purpose`.

Minimal executable repro: return a safe proposal with measured cost `purpose` containing a synthetic opaque value. Complete the proposal under empty policy into real SQL checkpoints. Reconstruct the factory with that value in `knownSecrets`. Replay succeeds as `not_verified` (trace-only proposal), reuses the stored cost and calls `ctx.recordCost` with the now-sensitive value. Engineer runs once and SQL rows remain unchanged. Reading those same persisted cost rows through `listJobCosts` into the report adapter refuses export, demonstrating that final report screening does not protect the earlier accounting sink.

Impact: a newly sensitive persisted cost field can be delivered to the accounting sink on replay. The test does not claim arbitrary external cost metadata is attacker-controlled or that an actual production sink exposes it publicly. The problem is the inconsistent policy at an observable callback boundary, not duplicate monetary settlement.

Proposed minimal fix: validate/screen the complete parsed cost with current policy before copying it into checkpoint keys/values or passing it to `recordCost`. Preserve usage and reconciliation holds; if strict refusal would lose accounting evidence, sanitize descriptive metadata and use trusted opaque identifiers for settlement. Screen sensitive external IDs before deriving sink idempotency keys as well. Do not simply drop measured usage. Convert ROT-1 into a refusal/sanitization regression after defining the accounting policy.

## ROT-2 — unchanged stored prompt redispatched after secret rotation

Production location: `packages/core/src/agents/session-service.ts`, `run()`, `resume()`, `recover()` → `attemptCreate()`.

Minimal executable repro (both `ambiguous` and `rate_limited`): first run a prompt containing a synthetic opaque value with no known secrets. Inject a fake create failure that creates no session. Persist the ambiguous row through real `FileBackedPorts`. Reopen the file, construct a fresh service, and run the identical spec with the opaque value now in `knownSecrets`. Recovery sends the persisted request body again using the original idempotency key and completes. The ambiguous case performs its normal local fake lookup before replay; the rate-limited case follows its direct retry path. An explicit new-attempt control rejects the identical prompt with `credential_in_prompt` and no third create, proving that the fresh-path policy is effective while recovery bypasses it.

Impact: an unchanged durable request can reach the provider dispatch port after the caller has supplied a policy that now forbids it. No real provider was contacted. Same-key deduplication does not excuse sending newly forbidden content.

Proposed minimal fix: apply the current prompt-secret check to the actual durable `rec.requestBody.message` immediately before every `createSession` dispatch, including recovered/replayed dispatches. Keep ambiguous reservations/evidence intact and require reconciliation when an old send outcome is unknown. Add a guard before lookup/poll/reuse too if policy requires all resumed access to stop; the concrete demonstrated defect is outbound redispatch. Preserve existing request-identity checks and same-key semantics. Convert both ROT-2 characterizations to refusal/no-dispatch assertions after the fix.

## Reproduction and exact validation

Existing local dependencies only; no installation or fetch:

```sh
ROTATION_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules node tests/track-b/security-release-assurance/rotation/run.mjs
node --check tests/track-b/security-release-assurance/rotation/run.mjs
git diff --check
```

Final targeted runner: exit 0; TypeScript exit 0; Vitest **1 file passed, 5 tests passed**, 5.31 seconds. Syntax and whitespace checks exit 0. The earlier targeted run also passed all 5 before adding unrelated-policy replay controls and the SQL-cost-to-report composition.

The runner stages current local source into a unique `mkdtemp` directory, excludes original test files, adds this one test and the existing fake provider helper, overlays contracts from already-present local Git objects, links existing dependencies and cleans up in `finally`. Tests use unique temporary file directories, cleaned in `finally`, and one isolated in-memory PGlite database. Set `TRACK_A_REF` to a local commit to change the contract overlay; the reported result used the default pinned SHA above. Parent owns combined strict scoped integration validation.

Files: `rotation.test.ts`, `run.mjs`, `report.md` in this directory. No production fixes, contract/manifests/app edits, other-team artifact changes, provider/cloud/network calls, real secret access, spending, outreach, deployment, push or PR. Limitations: fake provider and local PGlite/file adapters establish local boundary behavior, not live SDK behavior, production PostgreSQL concurrency, durable accounting settlement, or end-to-end workflow dispatch. Existing historical artifacts are preserved and can still contain values that only later became secrets; these tests address their consumption, not retroactive erasure.
