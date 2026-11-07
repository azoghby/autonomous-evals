# Track B private chat security review

Reviewed baseline `800a0b243fd251e1b7df62e8d5f1dfcc734ddb59` on 2026-11-07, including all production files under `packages/core/src/reporting/chat/`, its PostgreSQL migration, existing tests, `docs/track-b-progress-chat.md`, `docs/track-b-chat-persistence.md`, README, PLAN and TRACKS. No repository AGENTS.md files were present; the supplied ownership and opt-in instructions were followed. Production code, other delegates' paths, Track A apps/contracts and manifests were untouched. No delegation, cloud calls, spending, outreach, pushes or PRs occurred.

## Result

No new caller-reachable authorization, cursor, replay or question-injection defect was reproduced within this component's documented trusted-port model. The new isolated suite passes strict TypeScript checking and **15/15 tests**, zero skips/todos. Existing reporting checks pass strict TypeScript checking and **41/41 tests across five files**, zero skips/todos. These are component checks, not a production security certification.

Two executable boundary reproductions establish limits of grounding validation. They assert the observed unsafe content propagation so the review stays runnable against unchanged production code; a passing test here does **not** mean the limitation is fixed. Both limitations are already acknowledged by the implementation handoffs and require a trusted adapter/writer violation, rather than malicious question JSON.

## Proven boundary behavior

1. **Shape-valid stored replies are trusted semantically.** After a legitimate send, the review directly updates its local SQL row with a nonempty synthetic private provider body in `reply.text` and a synthetic private prompt in `reply.unknowns`. Both replay and history return those values unchanged. `ChatReplySchema` checks structure and bounds, not provenance, grounding, secret redaction or evidence ownership. By comparison, empty text, extra provider fields, URL references, invalid timestamps and invalid topics all fail closed with the fixed `storage_error` response. This establishes a stored-record integrity limitation; it does not establish a route allowing customers to update replies, an SQL injection, or a cross-user read.

   Integration implication: keep reply writes private to the deterministic service through trusted server code; never persist provider/model/user prose as a prevalidated reply. Database write access is trusted. If the application needs to detect semantically altered records after a writer compromise or accidental overwrite, schema validation alone cannot meet that requirement; it needs an independently trusted integrity/provenance design. No such new requirement or production fix is claimed here.

2. **Opaque-looking private tokens pass as evidence references.** A trusted progress adapter returning `SYNTHETIC_PRIVATE_TOKEN` as `statusEvidenceRef` causes that token to appear in poll `reply.evidenceRefs`. The token is absent from answer text but is still present in returned JSON. Syntax cannot establish customer visibility. Raw URLs fail validation, and extra prose fields are rejected, but a token satisfying the ID regex passes.

   Integration implication: the Track A projection must map only durable, authorized customer-visible evidence IDs, never tokens, URLs, session IDs or source bodies. Evidence resolution routes must independently authorize subject/job/evidence relationships. UI text rendering does not remove leakage from JSON. This reproduces the handoff's stated adapter obligation; no concrete production projection exists in this reviewed path to verify it end to end.

## Clean checks

- Service plus real PostgreSQL adapter/migration SQL in PGlite isolates identical message IDs across two users sharing a job and across two jobs, including independent sequence allocation.
- Revoked access blocks saved-message replay, history and polling with a formerly valid cursor before any progress read. Resolver results for the wrong subject or job fail closed. Extra browser identity fields are rejected.
- Another user's/job's cursor yields a different current cursor after authorization. Arbitrary valid-format cursors only trigger a refreshed answer; malformed cursors fail validation. A caller can compute the unkeyed hash for a known scope/projection and receive `changed: false`; this is the documented change-marker behavior and grants no access. Polling writes no history.
- Twenty same-input concurrent service sends produce one stored exchange and identical returned exchanges; subsequent replay avoids progress reads. Sixteen different-input sends produce one winner, fifteen conflicts and one stored row. These use PGlite's serialized transaction callbacks and establish service/SQL composition, **not independent-session PostgreSQL lock correctness**.
- Structurally corrupt stored replies fail closed through both service replay and history. Synthetic cross-scope driver rows are rejected by PostgreSQL get/list even when their message ID, digest and reply look valid; those driver-fault tests are not production database isolation evidence.
- A synthetic injected question marker appears in neither the returned exchange nor persisted reply JSON. Wrong-job snapshots and extra provider-body fields fail closed. Existing reporting tests additionally verify durable file scope validation/races, SQL parameters, bounded exclusive pagination, rollback, unsafe integer rejection, fixed database errors and restart replay.

## Reproduce locally

From the repository root:

```sh
npm ci --prefix tests/track-b --offline --ignore-scripts --no-audit --no-fund
node tests/track-b/chat-security-review/run.mjs
node tests/track-b/run-checks.mjs --components reporting --track-a-ref origin/track-a
```

The dependency installation used the existing lockfile and local npm cache: 58 packages installed with no registry calls. If the cache is unavailable, supply a compatible existing installed dependency directory using `CHAT_REVIEW_NODE_MODULES=/absolute/path/to/node_modules` for the isolated review runner. No dependencies or manifests were added. The new runner copies chat production files verbatim and its review test into an OS temporary directory, runs strict checking and Vitest, verifies every review test passed without skips/todos, then removes the temporary directory. It does not modify the shared harness. **The shared reporting harness does not discover this owned review directory; run both commands.**

Recorded review execution: strict check passed, 15/15 tests, one file, 45.56 seconds. Recorded reporting execution: strict check passed, 41/41 tests, five files, 29.10 seconds. `origin/track-a` resolved locally to `afd473788741e480b1e1bdf7728e451b5d47aaed`, contract digest `67a98dc7ddab55f56223fe40b402edae6bd0edbab4d4d070a19706fc006ae915`. No fetch occurred. Contract revision differs from the earlier persistence handoff; both the exact revision and digest above describe this review run.

## Remaining integration verification

No native PostgreSQL server or managed Neon database was started or contacted. The earlier persistence handoff records native locking tests, but this review did not rerun them and does not count that evidence as its own. Independent pinned connections, READ COMMITTED locking, rollback under contention, ambiguous commits, managed failover and restart behavior still need deployment-appropriate verification. PGlite cannot prove these properties.

Track A still must wire real session authentication/owner authorization before every method, preserve caller-private scopes for operator viewers, implement a consistent safe projection, apply the migration transactionally with a controlled search path, restrict table grants, bind a pinned transaction wrapper, and own identity/job foreign keys or RLS, retention and evidence-route authorization. None of those application/deployment properties is established by these isolated tests. Route responses need `Cache-Control: no-store`; rendered replies must remain text. No production change is included or implied by this review commit.
