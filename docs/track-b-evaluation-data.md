# Track B evaluation data acquisition

Implemented under `packages/core/src/evals/data/` only. Read PLAN.md, TRACKS.md, existing evals/types.ts and targets/text.ts. Three independent Codex implementation children handled quality/provenance, acquisition, and expert drafts/tests; integration added durable filesystem persistence. No ECC, external messages, recipients, hiring, provider calls, cloud provisioning, or spending. All fixture facts and source records are authored test data, not public discovery or external validation.

## Server interfaces

Import from `packages/core/src/evals/data/index.ts`:

- `assessDataQuality(spec, cases, sources, {knownSecrets?})`: task-specific minimum coverage, accepted case IDs, factual answer approval IDs, reasons, and sufficient/insufficient/unassessed status. Consumers must filter by accepted IDs; candidate arrays are not approved suites.
- `acquireEvaluationData(spec, initialBatch, ports)`: one bounded workflow step; durable insert-if-absent and revision CAS, discovery → generation → expert review. Call again with the identical task and initial batch after pending results. Ready tasks replay without external operations. Changed scope/initial evidence under the same task ID fails closed; use a new task ID for a changed evaluation.
- `evaluationDataProgress(task)`: safe fixed prose and acquiring/ready/waiting_for_data/waiting_for_expert state, factual correctness assessed/unassessed, and ready/inconclusive outcome. Missing evidence never implies a passing result.
- `createExpertRequestDraft(input)`: scope, questions, required qualifications, consent constraints, review checklist; draft_not_sent, null recipient, explicit no sending/spend authority.
- `reviewExpertContribution(task, contribution, trustedReview)`: authenticated consent/qualification/conflict checks and exact-answer independent review. It removes contributor-supplied verification. Follow acceptance with the shared quality gate.
- `createFileEvaluationDataStore(directory, knownSecrets?)`: concrete durable local adapter, intended for trusted persistent single-host storage, not Vercel ephemeral disk.

`DataTaskSpec` binds job, task, target identity, task description, explicit coverage requirements and minimum counts, factual-answer requirement, and intended uses. `DataSource` records HTTPS source/license URLs, permission allowed/denied/unknown/mixed, allowed uses, content, origin/producer, retrieval timestamp, SHA-256 content integrity, and review status/reviewer/time. Permission is checked per source across every requested use. Review does not make synthetic or target-origin content independent evidence.

`EvaluationDataCase` binds requirements, source IDs, synthetic label, generator lineage, expected answer, and answer-specific verification. Approval binds the full reviewed task, case, approval metadata and referenced evidence context; editing it invalidates approval. Factual cases require independent reviewed evidence or a qualified, consented expert attestation. Target answers and generator self-approval are rejected. Behavioral synthetic cases without factual answers may satisfy explicit behavioral coverage while factual correctness remains unassessed. Synthetic cases retain their label after verification.

## Ports and trust boundaries

`EvaluationDataPorts` injects `discover`, `generate`, `expert`, optional `reviewCandidates`, `store`, clock, and known secrets. The module performs no network calls. Discovery adapters must retrieve bounded, authorized public material and verify URL/content/license provenance. No copyrighted dataset scraping is included. Network adapters must enforce HTTPS, DNS/private-address protection, timeout/byte limits and safe redirects; the quality gate validates metadata, not network resolution or legal ownership.

Every acquisition request includes a deterministic operation key, task, current coverage gaps and explicitly untrusted source/case content. Embedded instructions remain data. Generation is forced synthetic with an operation-key generator identity; provider review/verification claims are stripped. Discovery and expert candidates also cannot approve themselves. A separate authenticated `reviewCandidates` adapter reviews the accumulated corpus, allowing later expert arrivals to verify earlier synthetic cases. It can add independent evidence and review metadata while preserving case inputs/answers/lineage. Approval metadata must come from a trusted server-side reviewer ledger, never parsed from model/source text. Initial batches likewise must be constructed by trusted server adapters; do not accept arbitrary client verification records.

The expert port receives a concrete draft and polls authorized contributions. It has no sending operation. Authorization for concept outreach grants no recipient selection, delivery, hiring, compensation, or spend. Those actions require separately scoped authorization and app integration.

A `pending` result or provider/review exception preserves the phase and returns waiting_for_data or waiting_for_expert, with generic diagnostics. Providers must durably deduplicate the operation key, including ambiguous failures and concurrent workers, and poll existing work on repeat calls. Exactly-once external execution cannot be supplied by database CAS alone. Completed but insufficient expert results remain waiting_for_expert and can be polled for later review. Content revisions need new case/source IDs. Task and decision rows are persisted together; duplicate decision identities do not append another record.

## Persistence and safety

`EvaluationDataStore` requires get, first-write insertIfAbsent, and atomic compareAndSet of the entire record at the expected revision. Track A should implement these in Neon, with globally scoped opaque task IDs, job ownership checks, request-hash conflict checks, transactional task+decision writes, and access/retention policies. Source content and consent receipts are private evidence, not chat text or unrestricted suite exports. Filter exports by license redistribution permission separately from evaluation permission.

The file adapter hashes task IDs into paths, uses private file modes, cross-process exclusive lock directories, checksum envelopes, byte limits, atomic rename and file/directory fsync. A competing writer gets a retryable busy error; it never steals locks. A crash can leave a lock directory: stop writers before operational cleanup. Provision and protect the root as private persistent storage. Filesystem administrators are trusted; the checksum detects corruption, not malicious administrative edits. Storage failure fails the workflow step rather than claiming a persisted result.

`inspectDataSafety` uses the existing `redactSecrets` API, known-secret values, and conservative PII patterns before persistence and before provider requests. Detected records are rejected rather than partially scrubbed and approved; errors do not echo content. PII screening is a conservative safety net, not full DLP: adapters must minimize personal data, use opaque contributor IDs, keep identity/consent records private and supply known secret/PII strings. Existing redaction tests were not changed or weakened. No prompt/source instructions execute.

## Remaining app wiring

Track A must authorize the job before service calls, persist the store in Neon, inject bounded discovery/generation and independent expert-review adapters, and resume the step through Workflow/hooks when data arrives. Any future paid model generation must use existing budget/session reservation ports, not an unmetered adapter. No provider integrations are silently enabled here.

Persist acquisition status and decision IDs as evidence for progress. Map waiting_for_data/expert to explicit customer-safe blockers/milestones while preserving the existing application lifecycle contract. The progress-chat service in commit ce4d2830ad467816d1ed4ed16c3366b5a2b67633 uses a constrained ProgressSnapshot; these acquisition states are not automatically valid chat job states. Track A must add an agreed blocker projection or extend that schema, bind opaque evidence references, and pass no raw source excerpts, URLs or review notes. No app/chat schema files were edited. The existing TextTargetPort/createTextTarget bridge is unaffected: approved data must be mapped into the frozen text suite by the workflow before execution. Data coverage is not a target evaluation outcome.

## Verification

The existing strict harness stages all nested data tests automatically. No manifests or harness files were edited.

```sh
node tests/track-b/run-checks.mjs --track-a-ref origin/track-a
```

The full run is blocked by existing schema-compat.test.ts:32 drift (`false` fails constraint `true`). At the final run origin/track-a resolved to d158da28a55acad39f9b7c3830aa24fd60cca3a3. Excluding contract-schemas at that ref also encounters its new contracts/conformance.test.ts importing the app-only alias `@/server/services`, unavailable in isolated staging. These external failures are not weakened or hidden.

For a strict isolated check against the available earlier contracts without that app-only test, use revision 07cf5dfe811de25ce31c4ed1ac05cb3b4a1f5b4f and explicitly selected components. Final test counts are reported in the implementation handoff. Fixtures cover coverage gaps, permissions, provenance hash mismatches, independent evidence/expert approval, target/generator contamination, secrets/PII, malicious embedded instructions, asynchronous replay/review, concurrent CAS, draft restrictions, restart durability, corruption, and path isolation. No live-provider or production app verification is claimed.

Final validation on this change:

- New data module: 4 test files, 46 tests passed (23 quality, 9 acquisition, 11 expert, 3 persistence).
- Strict harness at 07cf5dfe811de25ce31c4ed1ac05cb3b4a1f5b4f, selected agents,evals,reporting,targets,judges,monitoring,contract-targets,contract-evidence: 322 tests passed, no skips; strict compilation passed.
- Separate simulator,contract-branches selection at that revision failed existing PGlite acceptance/branch-ledger timeouts (5 seconds) and workflow setup timeout (10 seconds); 157 tests passed, 2 failed, 14 workflow tests did not execute because setup failed. No simulator/test timeout edits were made. Full validation is therefore not green.


## DQ-1 / DQ-2 correction contract

Authenticated answer approvals now require `contextDigest = answerReviewContextDigest(task, candidateWithVerification, sources)`. Set all verification fields first; the helper excludes only `contextDigest`, binds the full task and non-verification case, and includes full records for every case source and verification evidence ID. Canonical object key order is ignored; array order is preserved. Any question, scope, coverage, lineage, answer, evidence content/provenance/license/review or approval-metadata edit invalidates the binding. It is a versioned integrity hash, not a signature or permission to approve. The authenticated reviewer must persist the reviewed snapshot and binding together. Do not compute a new digest to grandfather legacy approvals.

For experts, persist `ExpertContributionReview.contextDigest = expertContributionContextDigest(task, contribution)` at authenticated independent review time. This binds contributor, all case payloads and sources, qualification evidence, and complete consent/receipt/use metadata. Incoming contributor verification is excluded and discarded. The helper checks that snapshot before emitting answer attestations, carries it as `expertAttestation.contributionContextDigest`, and computes the answer binding. Legacy answer/expert approvals lacking required bindings are rejected. Edits require new contribution/case/source IDs and fresh review; enforce immutable contribution IDs in the authenticated intake ledger. Target/generator/contributor self-approval remains prohibited.

Acquisition rejects changed reviewer case payloads, unknown reviewed cases and duplicate review IDs; it passes detached inputs to provider/reviewer ports. The verified registry preserves configured approval bindings and requires matching referenced evidence payloads. Current acquisition `knownSecrets` screens loaded records before dispatch and ready replay, proposed writes, successful CAS responses and CAS-loser reloads. A persisted ready record must also pass current quality reassessment. Configure the same current policy on storage as defense in depth; acquisition does not depend on that storage configuration to block unsafe replay.

Validation: `node tests/track-b/data-quality-review/run.mjs` passed strict compilation and 81 tests across 5 files; `node tests/track-b/run-checks.mjs --components evals --track-a-ref origin/track-a` passed strict compilation and 211 tests across 18 files, none skipped. Local Track A ref: `e969708da6a2bee205fcff9f78faa5e242fdd3c3`. Both used existing offline dependencies via a temporary symlink, removed afterward. Earlier validation counts above are historical. No full Track B/app run, live provider/cloud validation, spending, outreach, push or PR was performed for this correction.
