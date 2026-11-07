# Track B core data quality review

## Correction status — DQ-1 and DQ-2 fixed locally

The findings below describe the reviewed base, before this correction. Both defects now have rejection regressions; no test deliberately asserts the unsafe outcome. Production edits are confined to `packages/core/src/evals/data/**`; other changes are this review runner/tests and the two data documentation files. No ECC, cloud/provider calls, spending, outreach, push or PR.

DQ-1: `AnswerVerification.contextDigest` binds a versioned canonical snapshot of the complete task, non-verification case payload, approval metadata (excluding the digest itself), and full referenced source/evidence records, including provenance, license and review. `ExpertContributionReview.contextDigest` separately binds the task and entire non-verification contribution, including all cases, sources, contributor, consent receipt/uses and qualification evidence. The expert helper carries that digest into the attestation and binds the resulting answer approval. Missing legacy bindings fail closed. Digests are integrity bindings, not authentication: mint them only after actual independent review, never automatically upgrade old approvals. Authenticated ledgers must keep snapshots immutable and assign new IDs to edited contributions.

Acquisition rejects changed or unknown reviewed case payloads and duplicate review IDs before attaching approvals. Detached reviewer/provider inputs prevent in-place mutation of stored candidates. The registry requires matching case and referenced evidence payloads and preserves configured bindings; it does not remint approvals. Provider results still cannot self-approve, and target/generator/contributor independence checks remain.

DQ-2: acquisition screens the complete loaded/insert-winner record with its current `knownSecrets` before provider dispatch or completed-task replay, validates proposed writes and returned CAS records, and screens CAS-loser reloads before returning them. Ready records also undergo current quality reassessment, so stale legacy ready approvals are rejected. Rejections use fixed diagnostics without returning sensitive records. Store-level screening remains defense in depth.

Current offline verification (existing dependency directory temporarily symlinked into `tests/track-b/node_modules`, then removed):

```sh
node tests/track-b/data-quality-review/run.mjs
node tests/track-b/run-checks.mjs --components evals --track-a-ref origin/track-a
```

Strict compilation passed for both. Isolated review: 5 files, 81 tests passed, none skipped (46 existing data tests plus 35 review regressions/controls). Eval harness: 18 files, 211 tests passed, none skipped. The locally available `origin/track-a` resolved to `e969708da6a2bee205fcff9f78faa5e242fdd3c3`; no fetch occurred. The review runner explicitly excludes adapters, which are covered by the eval harness. Context regressions cover question, task scope, coverage, lineage, answer, evidence, consent, qualifications, missing legacy bindings, reviewer mutation and CAS-winner safety for pending, unavailable and completed provider results.

Limitations: only the eval component harness was run, not all Track B components or the app. Fixtures and fake providers do not establish live factual accuracy, legal permission, production review-ledger authentication, deployment behavior or cloud integration. The original review limitations below still apply.

## Historical review

Reviewed base: `800a0b243fd251e1b7df62e8d5f1dfcc734ddb59`. Scope: core acquisition, quality, expert, and file persistence modules under `packages/core/src/evals/data/`. Read PLAN.md, TRACKS.md, docs/TRACK_B_INTEGRATION.md and docs/track-b-evaluation-data.md. No repository AGENTS.md file was found; the supplied ownership and ECC opt-in instructions apply.

In the original review, only this document and `tests/track-b/data-quality-review/**` were changed. Production code, existing assertions, Track A, adapters, integration code, journal code and manifests are untouched. No delegation, network/provider calls, spending, outreach, push or PR occurred.

## Proven failures

### DQ-1 — High: review approval is not bound to the reviewed question/context

`acquisition.ts:124` builds a map of reviewed cases by ID; lines 126–128 copy only verification onto the original case without checking whether the returned input or coverage/lineage matches. By comparison, source approvals require the non-review source payload to match at lines 130–133. `quality.ts` binds verification to the exact answer string, but not the question that gives that answer meaning.

Reproduction: discovery supplies “May a write-authorized user write?” with the incorrect answer “No.” The authenticated reviewer returns the same ID, but the question “May a read-only user write?” and an expert approval for “No.” Acquisition retains the original question, attaches the other question's approval, and persists `ready` with `factualCorrectness: assessed`. This is a wrong-question approval, not merely a cosmetic edit to returned data. The existing acquisition test intentionally asserts that changed inputs are ignored while approvals are retained; it was not modified.

The expert helper has the same binding limitation: `expert.ts:120` checks case IDs, and lines 122–125 check exact answers and evidence IDs. Its review record contains no contribution/case digest or reviewed input. A review valid for the read-only question still accepts the contribution after its question changes to write-authorized, with contribution ID, case ID, generator and answer unchanged. The resulting case passes quality admission as factually assessed.

Integration implication: authenticated identity alone is insufficient. The server-side review ledger must bind approvals to an immutable snapshot/digest of the task, full case and relevant evidence/consent context. Before accepting review output, reject mismatched case payloads as the core already does for source payloads. Expert contribution IDs must identify immutable content, with edits receiving new IDs. Until that binding is enforced, do not treat `ready/assessed` alone as proof that a reviewer approved the stored question. The reproductions assume a stale/misbound authenticated review or mutable contribution, not that a malicious unauthenticated model can mint a trusted ledger row.

### DQ-2 — Medium, configuration-dependent: resume bypasses the current acquisition safety policy

`acquisition.ts` screens `spec` and `initial` before loading storage, but the loaded record is not screened against `ports.knownSecrets` before the completed-task return or provider request (`acquisition.ts:87`, dispatch at line 92). A pending provider result also saves before re-running the corpus quality gate.

Reproduction uses the actual file adapter, not a memory-store substitute: acquire and persist a candidate with an otherwise unrecognizable opaque confidential fixture string, reopen the store, then supply that string in the next call's `ports.knownSecrets`. The generation request still contains it in `untrustedData`; the task becomes `waiting_for_data`. A separate ready-task reproduction returns the persisted case as `ready` even though `inspectDataSafety(replay, currentKnownSecrets)` rejects it.

Integration implication: re-screen loaded records before any provider request or ready replay using the current safety configuration. For the current file adapter, supplying the same current list to `createFileEvaluationDataStore(root, knownSecrets)` blocks the read and prevents dispatch; a dedicated negative control proves this mitigation. Passing it only to acquisition is insufficient. The same invariant must hold for the future database store. This does not prove exfiltration by a deployed provider; it proves that the local provider port receives data the acquisition call is explicitly configured to reject. With an unchanged policy, or a store independently enforcing the current policy, this reproduction does not apply.

## Verified controls and limits

The added tests confirm discovery, generation and expert provider results cannot grant their own factual approval. The quality gate rejects missing evaluation permission, changed source content hashes, synthetic ground-truth evidence, target-produced evidence and generator-produced evidence. The expert helper rejects missing qualification verification and reviewer identities equal to contributor, generator or target. Existing data tests also cover intended-use permissions, exact-answer edits, consent, pending/resume operation keys, concurrent CAS, restart durability and corruption. These checks remain intact.

No independent failure of file CAS or checksum handling was reproduced. This review does not establish legal ownership, public-source retrieval authenticity, reviewer qualifications outside the trusted adapter, or factual truth through semantic comparison of arbitrary text. Source/license metadata and expert verification records remain assertions from trusted server adapters. HTTPS metadata checks are not network/DNS protections. Exactly-once external execution still requires provider-side durable operation-key deduplication. Those are integration responsibilities/risks, not additional reproduced production failures here.

## Reproduction and results

The owned runner copies the actual data modules, existing four data test files, `agents/redact.ts`, and `evals/types.ts` into a temporary directory. It runs strict TypeScript compilation and Vitest, then removes staging. It requires an existing dependency directory and never installs or fetches anything. It does not import or test the concurrently implemented adapters/integration/journal modules or Track A contracts.

```sh
# Normal checkout with tests/track-b/node_modules already installed:
node tests/track-b/data-quality-review/run.mjs

# Exact offline command used in this isolated checkout:
node tests/track-b/data-quality-review/run.mjs --deps '/Users/alexzoghby/.t3/worktrees/YC Hackathon 2/t3-1045f043/tests/track-b/node_modules'
```

Historical pre-fix result: strict compilation passed; 5 test files, 63 tests passed, none skipped. This comprises the existing 46 data tests and 17 review tests (4 defect characterizations, 13 controls). At that base, tests named `OPEN DEFECT` deliberately asserted the unsafe result. Those tests are now replaced with rejection expectations. A green result here therefore confirms the findings remain reproducible and is not an integration acceptance gate. No mocks or fixtures in this review prove production app, database, network, expert-ledger or live-provider integration. The full Track B harness was not run; its contract/simulator issues documented in the implementation handoff are neither cleared nor newly verified by this isolated run.
