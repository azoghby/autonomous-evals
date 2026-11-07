# Track B objective design admission

## Live recheck: useful design acceptance remains open

The same ordinary-language fictional-service brief was rerun against this gate on
November 7. Both allowed engineer drafts were rejected; no investigator or target
was dispatched and no suite was admitted. Measured costs were 75,142 and 133,118
micro-USD (total **$0.208260**), within the $1 diagnostic job ceiling. This is evidence
of bounded refusal, not successful suite-design acceptance. The grammar also refuses
legitimate constraints expressed in mixed prose, so replacing useful objective coverage
with unconditional refusal is not the finished product. Further work must preserve
explicit natural-language constraints without reintroducing literal factual checks.
[Recorded fixture outcome](../tests/track-b/live-evidence/text-design-admission-2026-11-07.json).

The November 7 live diagnostic approved `S01.o1 contains "3"` even though “The basic plan permits three projects.” correctly conveys the reference fact. Engineer and investigator agreement is insufficient for objective admission. `admission.ts` now rejects that actual suite before execution; reference text never supplies objective constraints.

## Deterministic boundary

`explicit_output.v1` builds a code-owned catalog from the authoritative system prompt and each scenario's actual user message. Entries record source, scenario scope (null for system), UTF-16 start offset, verbatim quote, deterministic source/offset ID, and the exact evaluator specification. Agents cannot supply their own supporting quotes. Catalogs are recomputed and compared structurally, including quotes, offsets, scope, IDs and specs. Checks must match a catalog entry in their own scenario or the system scope; supplied constraint IDs must also match. New designs bind IDs in code and freeze the catalog with the reviewed suite. Changing provenance changes the suite digest.

The accepted grammar is deliberately small. A source is machine-admissible only if **every nonblank line** is a supported instruction; a mixed-prose source contributes no constraints. Matching is anchored to the whole line, with CRLF supported. An imperative substring inside a conditional, example, quotation, code fence or other surrounding prose does not qualify. Reference text, titles, rationales, check descriptions and rubrics are never parsed as output instructions.

Each line starts with `The response must` or `Your response must`, followed by one of:

- `contain the literal "READY".` or `not contain the literal "SECRET".`
- `contain at least one of these literals: ["yes","no"].`
- `have at most 50 characters.`, `have at most 50 words.`, `have at most 2 lines.`, or `have at least 5 characters.`
- `be valid JSON.`
- `be a JSON object with these required keys: ["answer"].`

Strings/arrays use JSON escaping. Literal rules are case-sensitive; adding ` case-insensitive` immediately before the final period explicitly permits case-insensitive checks. Limits and collection sizes still pass through the existing objective schema. All other language is unsupported, including conditional requirements, approximate bounds and natural-language exact-number instructions. For example, `The response must contain the literal "3.00".` justifies that literal substring check; “the plan permits 3 projects” does not. Contains checks do not assert equality of the complete response. Existing Unicode/word/line/JSON evaluator semantics remain unchanged.

Specifications must match exactly. The validator does not infer weaker bounds, case relaxation, numeric spelling equivalence, or new JSON keys. Unsupported instructions may be assessed with rubrics, including reference-grounded factual rubrics. A reference fact containing a digit, date, weekday or canonical wording never by itself justifies literal matching.

## Design, review and compatibility

Code admission runs before investigator dispatch. Unsupported objectives produce check-specific rejection feedback and use the existing single bounded engineer revision. Repeated rejection blocks the suite. No check is automatically removed, replaced or weakened. A replacement draft must preserve the intended coverage under agent review; there is no deterministic proof of semantic coverage equivalence. Investigator review sees the derived catalog and bound check IDs. Admission version participates in task identity so older pre-gate sessions cannot resume as admitted designs.

`verifyFrozenSuite` remains the integrity-only reader for persistence and data-provenance sidecars. Low-level `freezeSuite` remains usable for historical callers without a catalog; its hash certifies content, **not admission**. If a catalog is supplied to freezing, it is validated. `designTextSuite` always supplies one after admission.

`verifyAdmittedFrozenSuite` is the separate mandatory boundary used by text execution, investigation, reruns and monitoring. It checks integrity first, then admission. Legacy suites without catalogs are recomputed against the same conservative grammar: safely justified suites retain their original bytes and digest; unsafe or uninterpretable suites throw `FrozenSuiteAdmissionError` before outbound target/judge/agent work or monitoring projection. No legacy hashes are rewritten and no catalog is silently added. Integrity-only storage/export remains available for diagnosis. Callers must preserve the admission error as a suite/test defect or operator blocker, never a customer failure or a successful empty run. Re-design is required to obtain a new admitted suite/digest.

The shared test fixture now explicitly states its READY and forbidden-marker constraints in scenario messages. This preserves the premises of the existing scoring/evidence tests (including null-system cases); no assertions or T1–T3 safety behavior were weakened. The live JSON is copied byte-for-byte under text test evidence because both isolated harnesses stage that directory independently.

## Verification and limits

Offline validation passes strict TypeScript and 241 eval tests across 19 files, including 12 integration service tests and 5 PGlite checkpoint tests. Isolated text security review passes strict TypeScript and 96 tests across 5 files (the original 66 plus 30 admission regressions). These exercise the actual live frozen fixture and unchanged digest, correct factual paraphrases, numeric/date/weekday facts, explicit literal/format requirements, supported bounds/JSON, fabricated provenance, cross-scenario IDs, empty/null inputs, context ambiguity, safe legacy loading, quarantine before outbound work, and bounded revision.

This is syntactic admission, not a semantic theorem prover. It intentionally sacrifices objective coverage for ambiguous prose: even the live diagnostic's paragraph containing a legitimate 50-word limit contributes no catalog entries. System instructions are never rewritten into the grammar. Scenario-authored explicit constraints can be legitimate tests, but agents can still propose irrelevant/trivial tasks or conflicts with system instructions. Investigator review remains responsible for task relevance, hierarchy, conditional applicability and semantic coverage. Rubric judgments remain subjective; paraphrase correctness is not converted into definitive code results. The parent's next bounded live check must assess quality and coverage as well as whether code admission blocks unsound objectives. No new live calls or provider spend were made here.
