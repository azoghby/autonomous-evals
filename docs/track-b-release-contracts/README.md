# Track B release compatibility: blocked

The single combined strict scoped run exited **1** on November 7, 2026 (Pacific). This is executable local evidence of unresolved dependency declarations, migration deployment conditions, app composition gaps, and incomplete appended-pack coverage. It is **not release acceptance**. No production fixes were made.

## Exact local inputs

- Parent/main baseline: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`.
- Already-local `origin/track-a`: `8634ceb30f3d98de7ec24b240a4f7549dce80033` (no fetch).
- Baseline `packages/core/src` tree: `ed2ca4916a748068ba015a90c6386dccb8846f27`.
- Track A `packages/core/src` tree: `07357986bcb7820b928085576ee85d87b9b5db3e`.
- Integrated child head at execution: `a942ff98bfc751752cb35cf704cc195e10758a59`. The combined runner was present as an uncommitted owned artifact at execution and is committed alongside this report/logs; source inputs were unchanged from the baseline.

The runner rejects tracked changes and untracked files outside the two owned directories relative to the base. Exports use the complete exact Track A archive. SQL uses baseline B artifacts plus all 15 pinned Track A migrations. Service/pack tests stage current B source with pinned A contracts/composition/lite/red-team files as documented by each child. These are explicit test compositions, not proof that a final merge or deployed app uses them. Mutable ref drift fails rather than fetching or silently changing the pin.

## One combined strict execution

From the checkout:

```sh
node tests/track-b/release-contracts/run.mjs --strict
```

This invokes each scoped child once, preserves stdout/stderr separately, continues after failures to expose all four results, and exits nonzero if any component fails **or** the service map retains release gates. There is no broad fixture run. [Machine result](combined/result.json) and `combined/*.stdout.txt` / `*.stderr.txt` are the integrated execution evidence (one trailing blank line was removed from pack stderr for whitespace hygiene); child transcripts are earlier individual runs.

| Component | Exact integrated result | Meaning |
| --- | --- | --- |
| Exports/manifests | Exit 1; 34 resolved/bundled subpaths, 329 valid consumer bindings, 3 matching manifest/lock entries; 66 undeclared import sites across 7 dependency pairs | Public export probes pass; direct dependency declaration gate fails. External dependencies were not bundled/executed. |
| SQL | Exit 1; 21 assertions passed, zero skips; 9 B artifacts and 15 A migrations inspected/executed | Positive coexistence/constraints and four hazard characterizations pass; unresolved deployment conditions prevent acceptance. |
| Services | Exit 0; strict scoped TypeScript and 14/14 tests pass, zero skips | Five local boundary acceptance cases and nine characterizations. All 12 methods and B1–B10 remain gated in the map. |
| Appended packs | Exit 1; strict scoped TypeScript passes; 15/19 tests pass, 4 fail, zero skipped/todo | Existing rejection boundaries pass; four desired fail-closed assertions fail. No new pack implementation was invented. |

The gate preserves `releaseAccepted:false`. Passing characterization assertions do not turn observed defects or missing integration guarantees into acceptance. Counts are different kinds of checks and should not be summed into a release pass rate.

## Owner handoff and minimal reproductions

1. **Track A manifests:** [exports evidence](exports/README.md), runner `exports/run.mjs --strict`. Core imports undeclared `resend` and `dotenv`; web imports undeclared `drizzle-orm`, `zod`, `stripe`, `@neondatabase/serverless`, and `@x402/core`. Every path/line is in [integrated JSON output](combined/exports.stdout.txt). This fails the owning-package declaration contract; it does not establish that workspace hoisting currently fails. Root/directory aliases are unavailable but no scanned consumer needs them, so they are not counted as defects.
2. **Migration/session owners:** [SQL audit](sql/AUDIT.md), runner `sql/run.mjs --strict`. Applying both chat artifacts raises `42P07`; the documentation copy's COMMIT escapes an outer transaction; incompatible preexisting tables survive IF NOT EXISTS; unqualified tables follow session search_path. These are deployment conditions, not evidence that a deployed runner applies both copies or uses an unsafe path. Select one chat artifact, define transaction ownership and trusted matching sessions, and validate existing catalog shape. The audit supplies exact SQL repros. PGlite does not certify independent sessions or advisory-lock behavior.
3. **Track A app/lite and B integration owners:** [service evidence](services/README.md), runner `services/run.mjs`. Actual pinned app `EVAL_SERVICES=real` falls back to lite for `designSuite`, `runSuite`, `investigate`, `proposeAndVerifyFix`, `rerunFinding`. S09 shows WRONG text passing a contains-REQUIRED objective via fixture judgment while B's real objective evaluator fails it; S10 shows redispatch/repeated IDs after factory recreation; S12 shows factual judgment without references; S07/S11 show placeholder branches and tool stubs. Bind authorized durable rich factories and preserve unresolved states. These are local executions with explicit host/provider doubles; no deployed crash or provider result is claimed. [Machine service map](../../tests/track-b/release-contracts/services/service-map.json) covers every method and all ten TRACKS B requirements.
4. **Pack/report/progress/comparison integration owners:** [pack evidence](packs/README.md), runner `packs/run.mjs --strict`. Real append logic yields 20 cases (12 base + 8 red-team). PACK-REPORT and PACK-SERVICE-REPORT permit clean reports without complete execution evidence. PACK-PROGRESS and PACK-COMPARISON show that base-only trusted resolver inputs can yield delivered/paired-pass results. The latter two are missing authoritative-inventory integration guarantees, not defects requiring every generic base-only comparator to reject. Carry full authorized inventory through real pack execution, both comparison sides, reports and progress; retain omission attacks when the pack team delivers its boundary. No pack/calendar execution acceptance is claimed.

Detailed child reports link individual test IDs, minimal inputs, observed/desired results and precise limitations. Production changes belong to those owners; this branch only adds test/report artifacts.

## Integration provenance and constraints

Exactly four Codex `gpt-6.1-sol` high children ran in distinct T3 worktrees, with disjoint exports/sql/services/packs subdirectories and no recursive delegation. Lead reviewed and cherry-picked only owned artifacts:

| Child | Original commit | Integrated commit |
| --- | --- | --- |
| SQL | `6dd7bffb9a816b4d68d0685328752248e17855a4` | `7176f25` |
| Exports | `d1b67ebd7e9ea0050aff217321c3854fc7e77c49` | `9746f91` |
| Services | `685f2a5b2456feeeba6087e67879a839e8c43ee8` | `b76f20f` |
| Packs | `040dc62a7dbb9bc0801a908eb9698fb382222e5f` | `a942ff9` |

ECC was disabled. No app/platform/contracts/manifests, workflow/chat/data integration patches, pack implementation, or other teams' artifacts were modified. Only `tests/track-b/release-contracts/**` and `docs/track-b-release-contracts/**` changed. No fetch, installs, external provider/cloud/network calls, credentials, spending, outreach, deployment, push or PR. Agent delegation itself used the explicitly requested T3 mechanism.

Offline dependencies are existing machine-local caches: exports defaults to `/tmp/workflow-bootstrap.JpxCTM/node_modules` (TypeScript 6.0.3, esbuild 0.28.2); other children default to `/tmp/autonomous-evals-checks.m10du4/node_modules` (including PGlite 0.5.15 and Vitest 5.1.0). Node was v24.21.0. Child READMEs document environment overrides. Missing caches hard-fail without installing. Temporary source/database stages are disposed.

Unverified: complete Next production build/runtime dependency installation; independent native PostgreSQL backends/concurrency/advisory locks; production ACL/RLS and session pools; real Naive/Gateway/DNS/HTTPS/Neon execution; authoritative pack execution/calendar integration; auth/payments/Blob/Workflow/redeploy recovery; customer delivery and deployment. The current refs do not include other active teams' future deliveries, and this report certifies none of them.
