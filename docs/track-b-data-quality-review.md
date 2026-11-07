# Track B core data quality review

Reviewed base: `800a0b243fd251e1b7df62e8d5f1dfcc734ddb59`. Scope: core acquisition, quality, expert, and file persistence modules under `packages/core/src/evals/data/`. Read PLAN.md, TRACKS.md, docs/TRACK_B_INTEGRATION.md and docs/track-b-evaluation-data.md. No repository AGENTS.md file was found; the supplied ownership and ECC opt-in instructions apply.

Only this document and `tests/track-b/data-quality-review/**` are changed. Production code, existing assertions, Track A, adapters, integration code, journal code and manifests are untouched. No delegation, network/provider calls, spending, outreach, push or PR occurred.

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

Final result: strict compilation passed; 5 test files, 63 tests passed, none skipped. This comprises the existing 46 data tests and 17 review tests (4 defect characterizations, 13 controls). Tests named `OPEN DEFECT` deliberately assert the current unsafe result to make it reproducible; they must be replaced with rejection expectations when fixed. A green result here therefore confirms the findings remain reproducible and is not an integration acceptance gate. No mocks or fixtures in this review prove production app, database, network, expert-ledger or live-provider integration. The full Track B harness was not run; its contract/simulator issues documented in the implementation handoff are neither cleared nor newly verified by this isolated run.
