# Track B security and release assurance

Base production source: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`.
Exactly four Codex `gpt-6.1-sol` high-effort children ran in separate T3 worktrees; none delegated further. The fifth agent integrated only owned test artifacts and this report. ECC remained disabled. No production files, Track A files, manifests, or other teams' artifacts were changed. No live provider/cloud/network requests, credentials, spending, outreach, deployment, push or PR operations were performed. Synthetic secret strings and local scripted ports were used.

## Release interpretation

The suite separates acceptance from defect characterization. A green characterization means the unsafe or inconsistent behavior remains reproducible; it does not certify release acceptance. Production fixes are outside this team's ownership and were deliberately not made. This review does not support an unqualified security-release approval.

The tests cover composed boundaries selected after inspecting prior reports and tests, rather than rerunning existing broad fixture suites. Real file adapters, checkpoint/review stores, SQL migrations, calendar simulator and SQL graders run locally where relevant. Mutation wrappers model retained mutable references at trusted caller/adapter boundaries; they do not establish a remote exploit, deployed authorization failure or tenant data disclosure.

## Reproducible combined check

From the repository root, using existing local dependencies:

```sh
TRACK_B_REVIEW_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules node tests/track-b/security-release-assurance/run.mjs > tests/track-b/security-release-assurance/results.txt 2>&1
node --check tests/track-b/security-release-assurance/run.mjs
git diff --check
```

The integrated runner stages current production code without original test suites, copies only six selected test files plus their helpers, overlays contracts from already-local Git commit `8634ceb30f3d98de7ec24b240a4f7549dce80033`, and uses one strict TypeScript compilation and one Vitest invocation with one worker. Missing dependencies or local contract objects fail rather than fetching/installing anything. It requires all 38 assertions and all six test files to pass, with no skips/todos, and removes its unique temporary stage in `finally`. Child test bytes are copied without transformation into layouts preserving their relative imports.

Contracts are absent from this Track B checkout, so this read-only local overlay is required. The identity child initially used `be522f1e13e697017bac96728748b82cadc08ab9`; integration standardizes all four suites on `8634ceb`. Between those two contract revisions only payment currency acceptance and suite scenario limit changed; neither is the subject of these identity assertions. The combined check is authoritative for the shared overlay. `TRACK_A_REF` and `TRACK_B_REVIEW_NODE_MODULES` accept other already-local inputs; such changes are a different validation configuration.

Combined execution: exit 0; strict TypeScript passed; **6/6 test files and 38/38 assertions passed: 29 acceptance/regressions and 9 defect characterizations, zero skips/todos**. Vitest duration: 22.06 seconds. Production source was staged from integrated HEAD `ef5e58e0056e47c654e9082621fb3e7b94e6e83c`, whose production tree is unchanged from `6ff8a06`. Raw integrated output is [results.txt](../tests/track-b/security-release-assurance/results.txt). Runner syntax and whitespace checks passed (exit 0); the production-tree diff against the base is empty.

| Slice | Acceptance/regression assertions | Defect-characterization assertions | Child commit | Integrated commit |
| --- | ---: | ---: | --- | --- |
| Secret rotation | 2 | 3 | `43d7f61` | `4edf835` |
| Immutable identity | 4 | 3 | `669f35d` | `f4c5fce` |
| Calendar and retained baseline | 14 | 1 | `f8ae62a` | `850f97f` |
| Evidence provenance | 9 | 2 | `7a3db58` | `ef5e58e` |
| Total | 29 | 9 | | |

## Reachable findings and minimal production fixes

Each row links a concrete executable repro and a detailed report with trust assumptions. Nine characterization assertions cover eight distinct findings; ROT-2 covers two recovery modes.

| ID | Observed behavior and composed boundary | Minimal proposed production change |
| --- | --- | --- |
| ROT-1 | A SQL-persisted remediation cost's purpose becomes a current secret. Replay sends it to `recordCost`, although subsequent report export refuses the same cost. | In `evals/remediation/index.ts`, screen cost metadata and external IDs under current policy before replay/accounting keys. Preserve measured usage and settlement evidence; define refusal versus sanitization explicitly. |
| ROT-2 | After file-backed restart, ambiguous and rate-limited recovery dispatch an unchanged prompt now forbidden by `knownSecrets`; fresh attempts correctly refuse it. | In `agents/session-service.ts`, check the actual durable request message before every create dispatch. Preserve ambiguous reservations and reconciliation semantics. |
| D1 | A resolved test projection plan's environment mutates during awaited reads; the production projector accepts a real live SQL run. An unchanged test plan refuses it. | In `reporting/chat/projection/index.ts`, detach the resolved plan before validation and give the reader a separate copy. Continue projection against the private original identity. |
| D2 | A real checkpoint lookup starts with digest A but accepts stored digest B after the caller key changes across the SQL await. The composed projector's earlier identity still contains this particular digest attack. | In `evals/integration/checkpoints.ts`, capture key primitives before awaiting and use the capture for SQL parameters and digest checks across operations. |
| D3 | Review read looks up the original receipt, then compares a changed caller digest after await and rejects valid replay. Availability inconsistency; no forged receipt accepted. | In `evals/data/review-ledger.ts`, clone read requests on entry, as submit already does. |
| C1 | A custom retained adapter changes its advertised identity during execute. Composition commits A but returns evidence B matching the replacement property; later replay detects drift only after the first result escaped. | In `monitoring/composition.ts`, snapshot/validate adapter readOnly and retained identity before awaits; use that same private snapshot for binding, returned evidence verification and output identity. |
| P1 | Legacy evidence round-trip assigns an entire human-readable location to runId and loses excerpt metadata; HTML/Markdown then make misleading provenance claims. Rich reporting preserves them. | In `evals/service-adapter.ts`, render legacy locations as opaque locations. Recover structured identity only from a strictly recognized canonical encoding; excerpt/reproduction fidelity requires rich evidence or explicit structured contract metadata. |
| P2 | Whitespace-tolerant trace citation matching accepts `alpha beta` against `alpha\r\n\t beta`, then exports the normalized string as exact untruncated evidence in JSON/Markdown/HTML. | In `evals/trace/audit.ts`, require literal inclusion or map normalized matches back to original source bytes; otherwise explicitly label normalization. Apply consistently to verdict and additional-finding evidence. |

Paths above are under `packages/core/src/` and remain unchanged. Fixing production should convert these characterizations into refusal, original-snapshot, or accurate-provenance assertions; retaining tests that assert the defects would fail after a correct fix.

Detailed minimal repros, exact child commands and limitations:

- [Rotation](../tests/track-b/security-release-assurance/rotation/report.md), executable `rotation/rotation.test.ts`.
- [Identity](../tests/track-b/security-release-assurance/identity/report.md), executable `identity/acceptance.test.ts` and `identity/defects.test.ts`.
- [Calendar](../tests/track-b/security-release-assurance/calendar/report.md), executable `calendar/boundaries.test.ts`.
- [Provenance](../tests/track-b/security-release-assurance/provenance/report.md), executable `provenance/acceptance.test.ts` and `provenance/defect-characterization.test.ts`.

## Passing controls and remaining limits

The acceptance tests establish current-secret refusal on persisted patch/report consumption, tenant scope snapshots in acquisition storage, environment/digest refusal with unchanged projection identity, and digest containment in a composed checkpoint-reader/projector. Calendar checks exercise partial infrastructure evidence, unknown claims, state-failure precedence, SQL-grade unavailability, immutable built-in retained artifacts, full retained digest/run binding, malformed custom identity refusal and replay without redispatch. They validate the `6ff8a06` fixes across real local calendar and checkpoint SQL, while distinguishing the remaining custom-adapter gap.

Provenance controls cover wrong-event/fabricated/mixed citations, malformed nested evidence, source versus prompt clipping, Unicode/CRLF and HTML-like bytes, rich and legacy rendered artifacts, and full-response objective failure/reproduction evidence beyond the stored prefix. A quote retained in source may validate despite being absent from the investigator prompt; a quote clipped out of normalized source is rejected. This is bounded code behavior, not a claim that a live model saw clipped evidence.

PGlite does not establish deployed PostgreSQL concurrency, RLS, Neon behavior, failover, real transaction isolation, or crash durability. File reopen tests establish local persistence/replay only. Scripted targets/runners do not establish real provider SDK behavior, production workflow wiring, accounting settlement, Markdown engine behavior or browser DOM behavior. No live credentials were accessed; newly sensitive historical artifacts are preserved rather than erased. Job IDs and trusted scoped ports remain deployment assumptions. Context/parser combinations and adversarial values are targeted, not exhaustive. No broad generic fixture suites were rerun.
