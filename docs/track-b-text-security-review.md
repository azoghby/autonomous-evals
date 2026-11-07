# Track B text security review

T1/T2/T3 are fixed locally in `packages/core/src/evals/text/**`. The review regressions in `tests/track-b/text-security-review/**` now assert safe behavior with ordinary tests; there are no expected failures. The original findings were proven against baseline `800a0b243fd251e1b7df62e8d5f1dfcc734ddb59` on November 7, 2026. This follow-up read repository ownership guidance (`TRACKS.md`, `docs/TRACK_B_INTEGRATION.md`) and the text implementation/review documentation. ECC was not used.

## T1 — clipped evidence and reproduction metadata

Baseline: a response `READY ` + 20,100 `x` characters + ` FORBIDDEN_MARKER` failed an objective absence check on the complete response. The genuine check evidence survived, but the investigator citation was checked only against the clipped stored response. A real failing reproduction was returned while the finding remained inconclusive and claimed `attempted: false`.

Fix: record reproduction attempt, run ID, reproduced status and check evidence before deciding whether to accept the investigator verdict. Verify its quote against either the stored response or the original candidate check's trusted retained evidence. Execution had already verified those check quotes against the complete response. Never substitute untrusted investigator text for missing evidence. Confirmation still requires investigator agreement and failure of the same objective check on reproduction.

Regressions confirm legitimate trailing quotes and substrings, reject fabricated/extended quotes, and retain attempted/reproduced metadata and check evidence for missing or rejected verdicts. A rejected quote with a passing reproduction records `reproduced: false` and stays inconclusive.

## T2 — blank factual reference

Baseline: empty/whitespace references passed the module's null-only absence guard. An injected passing judge could make factual correctness pass. The production Gateway already refused such references, so this was a module/injected-port boundary defect, not a proven live Gateway false pass.

Fix: normalize blank references to null before design task identity/prompts and before freezing a new suite. Preserve substantive reference text exactly. Do not add normalization to the frozen schema, canonicalization, digest computation or stored-suite verification: legacy blank bodies retain their original digest. Execution guards null and blank references before invoking any judge and returns `not_assessed/no_reference`; investigation records the same no-reference limitation.

Regressions cover empty and whitespace references, injected passing judges, the Gateway-bound path, normalized design task identities/prompts, new freeze output, legacy digest preservation and rejection of a silent stored-body edit.

## T3 — fabricated rubric pass citations

Baseline: the module returned pass before applying citation validation; a fabricated pass citation was dropped while the pass survived into monitoring. Fabricated concerns were already inconclusive. Gateway rejected fabricated citations for all verdicts, so no live adapter acceptance was demonstrated.

Fix: supplied invalid citations invalidate both pass and concern verdicts as `inconclusive/judge_inconclusive`. A legitimate pass may still supply no citations. Existing concern evidence requirements remain enforced. Regressions cover fabricated pass propagation into monitoring, empty/valid/invalid/mixed pass quotes, fabricated concerns and the independent Gateway rejection path.

## Verification

Both commands run offline using existing dependencies; neither installs, fetches nor contacts providers:

```sh
TEXT_REVIEW_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules node tests/track-b/text-security-review/run.mjs
npm --prefix tests/track-b run check -- --components evals --track-a-ref origin/track-a
```

Review: exit 0; strict TypeScript; **66 passed across 4 files** (42 original Text Eval fixtures plus 24 review regressions), no expected failures. Selected eval harness: exit 0; strict TypeScript; **211 passed across 18 files, none skipped**, including `evals/integration/services.test.ts` (12) and `evals/integration/checkpoint.test.ts` (5). The checkpoint tests use local PGlite SQL. Contracts were read from existing local `origin/track-a` at `0dd312d1e41647ecd69f9fcb0ab4482c04e98f39`, contract digest `67a98dc7ddab55f56223fe40b402edae6bd0edbab4d4d070a19706fc006ae915`. A temporary dependency-cache symlink for the selected harness was removed after testing.

Initial review execution without a cache override failed on missing dependencies; selected eval execution without a contract ref failed on missing shared contracts. Existing local inputs resolved these. A new test typing error found in the initial compile was fixed. These failures did not require dependency, manifest, contract or integration changes. No full repository/all-component harness was run.

## Remaining trust boundaries

Stored execution/check evidence must come from authorized immutable parent storage. `assertRunMatches` checks identities, not provenance or recomputation of results, and permits intentional scenario subsets. SHA-256 checks content against a digest, not authorization of the body/digest pair. Persist scenario selection and the complete run/investigation, including reproductions and unresolved checks. Missing quotes beyond all retained evidence remain inconclusive.

Reproduction limits are per invocation; repeating investigation can resend selected requests. The integration layer was tested but not changed; parent durable checkpoints must prevent replayed sends. Schema-valid agent JSON and local transport stubs do not prove semantic model correctness, resistance to live prompt injection, provider availability, authenticated job binding or production integration. Fenced JSON remains accepted by documented objective semantics; this is not a strict JSON-consumer guarantee. No cloud calls, spending, outreach, push or PR occurred. Changes are limited to the text modules, these review tests and the two owned text documents; integration/data, Track A app/contracts and manifests are unchanged.
