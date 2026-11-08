# Provenance test child report

Base tested: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`.
Contracts: local Git object `8634ceb30f3d98de7ec24b240a4f7549dce80033` (the locally available `origin/track-a` at inspection). No fetch performed. Final test commit SHA is supplied in the handoff, since recording its own SHA would change the commit.

Only `tests/track-b/security-release-assurance/provenance/**` was written. Production, contracts, manifests, app/platform, and other teams' artifacts were read only. No children, ECC, network/provider calls, secret reads, installs, push, PR, or deployment.

## Results and exact commands

From repository root:

```sh
TRACK_B_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules node tests/track-b/security-release-assurance/provenance/run.mjs > tests/track-b/security-release-assurance/provenance/results.txt 2>&1
git diff --check
```

Both commands exited 0. Runner sequentially executes the existing local TypeScript compiler with `-p <unique-stage>/tsconfig.json` (`strict: true`, `noEmit: true`), then Vitest separately for acceptance and characterization, with `--root <unique-stage> --maxWorkers=1`. Strict scoped compilation passed; acceptance **9/9 passed**, defect characterizations **2/2 passed**, no skipped cases. Raw final output is in `results.txt`. Each execution creates its own `mkdtemp` directory and removes it in `finally`; dependencies are symlinked, never installed. The runner accepts a local contracts ref as its first argument and the dependency directory via `TRACK_B_NODE_MODULES`.

During test authoring an initial compile failed on fixture typing (Vitest tuple parameterization and required intake authorization field). The first executable run had one incorrect test assumption: source clipping is 20,000 characters, not 12,000. Those harness assumptions were corrected; the final recorded run passes. No production change was needed or made.

## Coverage chosen after reviewing existing work

Read the existing live trace Markdown report, trace audit/reporting unit tests, agent review, text security review, integration acceptance (including G2), and contract evidence checks. Those already exercise unit citation rejection, full-response scoring, and contract artifact preservation. These tests add assertions at composed boundaries rather than rerunning those suites:

- Wrong-event, fabricated, and mixed valid/invalid trace citations cannot promote findings; invalid quote text stays out of serialized report JSON, Markdown, HTML, and legacy report artifacts. Original deterministic evidence remains available and HTML escapes hostile source text.
- Malformed nested investigator evidence becomes schema failure via a contract-faithful local runner; the inconclusive findings and unavailable-investigator explanation reach both readable report formats.
- Exact Unicode, CRLF, backticks and HTML-like source bytes survive additional-finding validation, JSON serialization, safe Markdown fencing, HTML escaping, and rich service reporting. Investigator-only findings stay subjective.
- Distinguishes the 1,500-character investigator prompt excerpt from the 20,000-character normalized source limit. A suffix retained in source can validate even when unseen in the prompt; a suffix removed from source is rejected despite existing in raw input. Source clipping limitations reach all three report formats.
- Full text execution, candidate investigation, independent reproduction, and rich report adapter retain a trailing objective-failure quote beyond the stored response prefix. Valid evidence confirms; fabricated investigator evidence leaves the finding inconclusive while preserving the actual reproduction result. Rendered response evidence remains bound to the original scenario/run identity.

## Open defects (passing characterization is not acceptance)

### P1 — legacy text presentation corrupts run provenance and drops excerpt metadata

Reproducer: `defect-characterization.test.ts`, test starting `P1`. Convert a rich response evidence item `{scenarioId: 'S01', runId: 'baseline-1', truncated: true}` using `toContractFinding`, then render the resulting contract finding using `createTrackBServices().renderReport` without `richFindings`.

Observed HTML says `scenario S01, run scenario S01 run baseline-1`, while the rich path correctly says `scenario S01, run baseline-1 (excerpt)`. Markdown also loses `(excerpt)`. JSON produced from the restored finding contains the entire location as `runId`. The returned contract artifact itself stays intact, so the existing G2 artifact-equality test misses the presentation error. Reproduction outcome/run identity also cannot survive the shared count-only contract, an already declared lossy boundary.

Cause: `packages/core/src/evals/service-adapter.ts:136` assigns freeform `location` directly to `runId` and hardcodes `truncated: false`; `toContractFinding` does not encode truncation. Proposed minimum production fix: render legacy locations as opaque source locations instead of asserting reconstructed scenario/run fields. For locations generated by this adapter, a strictly recognized canonical location could recover run identity; arbitrary legacy locations must remain opaque. Retain `richFindings` for accurate excerpt/reproduction semantics. Restoring those semantics through the legacy contract requires explicit structured metadata, not guessing from prose. No production fix made.

### P2 — tolerant trace validation exports a non-verbatim quote as exact evidence

Reproducer: `defect-characterization.test.ts`, test starting `P2`. Source event is `alpha\r\n\t beta`; investigator additional finding cites `alpha beta`. The source never contains that literal substring.

Observed: additional finding accepted with `truncated: false`, and JSON, fenced Markdown, HTML, and rich-to-contract excerpt all publish `alpha beta` as source evidence. This is a representation defect, not evidence of an unrelated semantic claim: the verifier deliberately tolerates whitespace (`verifyCitation` in `packages/core/src/evals/trace/audit.ts`), but the prompt asks for exact copying and report quote metadata does not disclose normalization.

Proposed minimum fix: require literal `ev.text.includes(quote)` for accepted citations. If whitespace tolerance is a product requirement, map the normalized match back to the original source span and export the original bytes, or explicitly distinguish normalized citations in the evidence contract/renderers. Apply the same policy to verdict extra evidence and additional findings. No production fix made.

## Files and limitations

Owned files: `acceptance.test.ts`, `defect-characterization.test.ts`, `support.ts`, `run.mjs`, `results.txt`, `report.md`.

All execution is local/in-memory against copied real production code and pinned real contracts, with schema-validating scripted agent/target ports. This proves code composition and output strings, not live model behavior, Markdown engine/browser DOM behavior, deployment integration, persisted artifact authorization, or database semantics. JSON is the low-level renderer's serialized `ReportJson`; the shared report service exposes Markdown/HTML and contract findings rather than that JSON export. No SQL boundary was implicated by these targeted cases. Operator summaries are disabled to isolate source evidence. The 60 KB aggregate prompt budget, every parser input format, and exhaustive malformed values are not covered; tests specifically cover per-event prompt/source clipping and typed malformed evidence. Existing broad suites were not rerun. Parent owns integration and the combined strict scoped check.
