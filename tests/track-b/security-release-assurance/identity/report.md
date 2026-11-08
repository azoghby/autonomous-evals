# Immutable identity boundary tests

Base: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`.
Scope: only `tests/track-b/security-release-assurance/identity/**`.
ECC disabled; no delegation, production edits, network/provider/cloud calls,
secret access, dependency installation, deployment, push or PR.

## Coverage selection

Inspected existing data orchestration review (including its fixed mutable-submit
regression), PostgreSQL data-store and checkpoint tests, progress projection
review tests, and `docs/track-b-data-orchestration-review.md`,
`docs/track-b-progress-projection.md`, and
`docs/track-b-progress-projection-review.md`. Existing tests cover immutable submit snapshots, standalone SQL
scope isolation, wrong-job evidence and static digest/environment mismatches.
This suite targets mutable inputs spanning authorization/validation and awaited
durable reads, plus the composed protections which do and do not contain them.
It runs only seven new tests, not existing broad fixture suites.

`acceptance.test.ts` contains four passing security controls:

- Unchanged test plan refuses a completed live SQL run.
- Matching test SQL run survives the real get-only reader and projects completed
  execution with an inconclusive blocker (no checks means no passing verdict).
- Tenant A and tenant B have distinct same-task/same-job SQL records; mutating
  the caller's scope object after store construction cannot switch which tenant's
  acquisition state the production reader/projector returns.
- A changed checkpoint digest is refused by the composed reader/projector even
  if a nested get accepts the changed key. The reader's earlier copied identity
  disagrees with the mutated plan, so projection fails closed.

`defects.test.ts` separately asserts three observed defects. These green tests
are characterization, not release acceptance. Once production is fixed, replace
the observed-defect assertions with rejection or original-snapshot assertions.

## Findings and minimal repro/fix proposals (production untouched)

### D1: mutable resolved environment changes accepted SQL evidence

Persist a valid `live` run using the actual checkpoint SQL adapter. Resolve a
`test` ProjectionPlan. At the consistent-read adapter boundary, mutate that same
plan's environment to `live`. The production reader and projector accept the
completed live checkpoint. The paired unchanged-plan control rejects it.

Location: `packages/core/src/reporting/chat/projection/index.ts`, `project`.
Proposed minimal fix: take a private deep snapshot of the resolved plan before
validation; validate and project against that snapshot, and pass a separate copy
to the reader so neither a retained resolver object nor reader input can rewrite
the identity used after the await. Preserve all current association checks.

### D2: checkpoint get compares the post-await digest

Persist key `(identity-job, run_result, run)` with digest B and a completed marker.
Call real `PostgresTextCheckpointStore.get` with digest A. A query wrapper awaits
the actual SQL result, then changes the caller-owned key digest to B before
returning it. `get` returns the completed marker rather than reporting the
original A/B conflict. A fresh unchanged digest-A lookup correctly rejects.

Location: `packages/core/src/evals/integration/checkpoints.ts`, `get`.
Proposed minimal fix: snapshot all key primitives before the first await, and use
only that snapshot for identityParams and assertDigest; apply the same capture
rule consistently to every asynchronous checkpoint operation. The composed
projector rejects the key mutation in the tested reader path; D2 alone is not a
claim of a projector bypass.

### D3: review read mixes original lookup with a changed digest (availability)

Submit an authenticated human receipt to the real file operation ledger. Call
`readReview` with its valid task/data/digest. A get wrapper awaits the actual
ledger read, then changes request.task.jobId and recomputes request.digest before
returning the original row. The call throws `Independent review ledger binding
mismatch`: the lookup used the original digest, but the post-await check uses the
changed digest. The original private request still retrieves `decided` from the
same real ledger. This is loss of consistent read/replay under mutable inputs,
not unauthorized receipt acceptance or a forged receipt.

Location: `packages/core/src/evals/data/review-ledger.ts`, `readReview`.
Proposed minimal fix: deep-clone the whole request on entry, as submit already
does, before screening/hash validation or awaiting get. After that fix, the
in-flight read should return the original bound receipt rather than reject it.
Consumers must likewise retain their original request context across awaits.

## Execution

Command (offline, existing dependencies):

```
node tests/track-b/security-release-assurance/identity/run.mjs
```

Runner stages production code and these tests in unique `mkdtemp` directories,
loads the two real SQL migrations into local PGlite, runs strict `tsc --noEmit`,
then Vitest with one worker and checks exactly seven passes with zero skips/todos.
The file ledger uses a separate unique temporary directory; all are cleaned up.
Dependencies default to the existing `/tmp/autonomous-evals-checks.m10du4/node_modules`;
override with `TRACK_B_REVIEW_NODE_MODULES` to another existing local directory.
Missing production contracts are staged read-only from already-local commit
`be522f1e13e697017bac96728748b82cadc08ab9` (same pin as prior projection review).
No fetch or install occurs.

Initial development run: exit 1, three passes/four failures; the run fixture had
an invalid execution envelope and two PGlite tests exceeded Vitest's default
5-second timeout. Fixed only owned fixture fields, added the real SuiteRun type,
and set local test/hook timeouts to 30 seconds. Production was not changed.
Final run: exit 0. Strict TypeScript passed; 2 test files and 7/7 tests passed
(4 acceptance, 3 defect characterization), zero skips/todos; Vitest duration
22.35 seconds (final rerun after narrowing D3 to inconsistent replay). `git diff --check` also exited 0.

Commit verification command: `git diff --cached --check`, followed by a scoped
`git commit` containing only the five owned artifacts. The resulting commit SHA
is returned in the child handoff; this report does not embed its own commit hash.

## Limits and integration

PGlite executes real PostgreSQL-compatible migrations and adapter queries on a
serialized local engine; this does not establish Neon behavior, multi-connection
races, RLS, application auth wiring, or a real REPEATABLE READ transaction.
The test read adapter supplies fixed job/cost metadata and delegates actual
checkpoint/acquisition reads. Mutation wrappers deterministically model a
trusted adapter or concurrent caller retaining mutable references; they never
forge SQL results. No customer-reachable exploit or tenant data disclosure is
established. Checkpoint keys and review digests have no native tenant field;
production still needs the documented globally unique authorized job and trusted
tenant/environment-scoped ports. This suite does not certify that deployment
precondition. The parent owns combined strict scoped integration verification.

Files: `helpers.ts`, `acceptance.test.ts`, `defects.test.ts`, `run.mjs`, `report.md`.
