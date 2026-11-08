# Independent review of evaluation-data orchestration

Reviewed integrated `b302b36` (original `7aa0bbb`) at worktree HEAD `e47a852`. ECC disabled. Read the supplied AGENTS instructions, local PLAN/TRACKS, orchestration implementation/documentation, acquisition, review/operation ledgers, quality/binding/expert helpers, mapping/generation adapters, PostgreSQL/file stores and existing orchestration tests. No repository AGENTS.md was found. Changes are limited to this document and `tests/track-b/data-orchestration-review/**`; production is untouched. No network/provider/cloud calls, secrets, spending, outreach, manifests, push or PR.

## Findings

### R1 — P2: initial behavioral synthetic coverage skips authenticated review

Locations: `orchestration.ts:64–68`, `acquisition.ts:75–86` (initial assessment and complete-phase return), and orchestration's mapping/freeze path.

Trigger: caller supplies a valid task with `factualAnswersRequired: false`, a synthetic initial case covering its requirements, a generator ID, no expected answer and no source IDs. Stripping source reviews and case verification does not make this case insufficient. Acquisition inserts a ready/complete task and returns before invoking `reviewCandidates`.

Impact: unreviewed caller data is persisted as accepted and reaches the freeze service despite `readReview` always returning pending. This contradicts the new bridge's promise that imported evidence must pass authenticated review, including behavioral-only synthetic coverage. It does **not** falsely claim factual correctness: the demonstrated progress correctly remains unassessed. Actual final suite readiness still depends on the trusted freeze service; the test returns pending there and claims no completed app integration.

Proof: `CHARACTERIZATION P2: caller initial behavioral synthetic coverage bypasses human intake (actual SQL)` runs the actual PostgreSQL task migration/store in PGlite. A direct SELECT confirms persisted state `ready`; human reads and providers are both zero; freeze is invoked once.

Minimal fix: gate every initially sufficient snapshot through authenticated review before allowing ready/complete, even when no factual answers exist. Do not use missing verification as the sole marker that review is outstanding. Add an acceptance regression requiring pending human review to prevent freeze dispatch.

### R2 — P1 conditional: intake can authorize one job and mint an immutable receipt for another

Location: `review-ledger.ts:23–43`.

Trigger: an in-process caller retains the mutable `submit(input)` object. While `authenticateHuman(structuredClone(input.task))` awaits, the caller changes `input.task.jobId`. Authorization checks the original job; subsequent validation/digest construction uses the changed object. The test authenticator explicitly denies every job except the original fixture job.

Impact: a valid human session scoped to job A can mint a decided immutable review receipt bound to job B. This violates exact authorization/snapshot binding. The proof demonstrates an unauthorized-scope receipt, not successful factual admission or a remote HTTP exploit. Exploitation requires a caller able to mutate the shared object during the await; a host that deserializes a private request object and never exposes/reuses it may prevent that trigger. No malicious trusted authentication implementation is required.

Proof: `CHARACTERIZATION P1 conditional: mutable input changes authorized job after authenticateHuman snapshots it` uses the real durable file operation ledger and authenticated intake. Authorization observes the original job, but the changed job's digest retrieves a decided receipt. No forged ledger or fabricated passing API is involved.

Minimal fix: clone and validate the complete input synchronously at entry, then exclusively use that private snapshot across all awaits, authorization, payload comparisons, keys and digests. Test changing task, candidates, reviewed data, decision and receipt while authentication is blocked; the durable receipt must always refer to the authorized original snapshot.

### R3 — P2: reviewer-added sources evade producer independence checks

Locations: `review-ledger.ts:28–29,35–40`, equivalent candidate-only independence checks in `orchestration.ts`, and `quality.ts` independent-evidence admission.

Trigger: the authenticated human is independent of candidate generators/producers, but adds a new source whose `provenance.producerId` is that same human. They mark its source review approved and use it as independent evidence for their own answer verification. Intake checks producers only in `input.candidates.sources`, so newly added evidence is exempt. The quality gate excludes target/generator-produced evidence but does not exclude verifier-produced evidence.

Impact: the real authenticated review ledger accepts the self-produced/self-reviewed source, and the orchestration persists factual correctness as assessed and dispatches freeze. This contradicts documented reviewer independence from source producers. This requires an authenticated human submitting a conflicting review; it is not an unauthenticated model forging human authority, and it does not establish that arbitrary human factual claims can be verified by software.

Proof: `CHARACTERIZATION P2: reviewer-added source can be self-produced and self-reviewed factual evidence` submits through the real intake, feeds its real `readReview` into orchestration, runs the real SQL store, and directly selects persisted `assessment.factualCorrectness = assessed`. The companion acceptance test proves intake rejects the same producer conflict when the source was already a candidate. Freeze returns pending; no semantic suite service is replaced with a fake successful implementation.

Minimal fix: enforce producer independence across the complete reviewed source set, including added sources, in both intake and orchestration validation. Consider a quality-gate check preventing an answer verifier from presenting their own authored source as independent evidence. Contributions requiring expert authority should use the consent/qualification route and an independent reviewer.

## Validation and boundaries

The five added tests consist of three **characterizations of open defects**, plus two **acceptance controls** (existing-source producer independence; concurrent file claims and immutable completion). A green characterization confirms the defect remains; it is not a release acceptance pass. On remediation, replace each characterization's vulnerable expectations with the desired acceptance behavior.

The runner stages actual current production source, existing eval tests, existing orchestration tests and these review tests. It compiles all staged TypeScript strictly, executes every staged test, and rejects skipped/todo/unexecuted files. It never installs dependencies or fetches contracts. Dependencies are provided through `TRACK_B_NODE_MODULES` because this checkout has no node_modules. Reproduce with an existing dependency directory:

```sh
TRACK_B_NODE_MODULES=/absolute/path/to/existing/tests/track-b/node_modules \
  node tests/track-b/data-orchestration-review/run.mjs --components evals --track-a-ref origin/track-a
```

The local contract ref resolved to `2dff9d8af8cccdd171d78760a0d74136d138fcb4`, digest `dc7936cf343e023a9f0b3b2c0ee02b3886a1f230397f282ee4aaec84a9b27101`. Final validation: strict TypeScript passed; 447 tests across 29 files passed, none skipped. Recorded execution is in `tests/track-b/data-orchestration-review/results.txt`.

Existing tests exercised alongside the review cover exact task/case/source binding, expert contribution/consent context, changed-scope and changed-answer rejection, current-secret rejection on completed replay, source rejection fallback, measured-cost capture/delivery retry, provider ambiguity and explicit reconciliation, SQL CAS, and frozen-reference tampering. The new claim race proves at most one file-ledger owner; busy callers may reject. PGlite executes real PostgreSQL SQL with serialized transactions; it does not prove multi-connection PostgreSQL scheduling or multi-host file-lock behavior.

No additional caller-reachable cost/ambiguity defect was established. Current cost capture intentionally supports one immutable measured snapshot per operation. It screens captures, journals before delivery, and retries a documented idempotent sink; exceptions/pending effects retain ownership. This does not prove a real billing sink is durable/idempotent. Direct `operations.complete` is a privileged reconciliation capability; a hostile implementation/caller with that capability can fabricate effects, but is not an unauthenticated bypass demonstrated here. A hostile `readReview`, `freeze`, task store or operation ledger similarly crosses a documented trusted-port boundary. The bridge checks frozen integrity and exact scope/reference, while semantic suite admission remains the freeze service's responsibility.

Production authenticated session plumbing, durable shared operation ledger, real cost sink, reconciliation authority, consent collection and actual text design/review/freeze composition remain host integration requirements. Tests do not substitute successful fake implementations for those missing integrations. No review of the other team's secured remediation adapter or parent report/chat bug fixes was performed.
