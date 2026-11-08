# Workstream 5: bounded live acceptance

ECC disabled. Changes are limited to `tests/track-b/live-acceptance/**` and this file. No provider requests, secret access, cloud migration, deployment, outreach, push or PR is authorized by this workstream. The parent owns private configuration and approval of an exact bounded external run. Local disposable PostgreSQL and loopback TLS are permitted.

## Evidence already accepted

Reuse `packages/core/src/evals/text/__tests__/evidence/text-design-v3-2026-11-07.json`: twelve reviewed scenarios, frozen digest `0e5d6df16cd4c5953bb3a0966cf410216690549d3393cf60150d30b711a942e9`, two completed design/review sessions totaling **129,924 micro-USD**. No new design is needed. Earlier admission/rubric-binding artifacts are bounded rejections, not substitutes for this accepted v3 suite.

`tests/track-b/live-evidence/naive-configuration-verification-2026-11-07.json` records the read-only list/get/getVersion verification of four exact agent versions; it created no agents. The offline runner checks its directory against the prior four-role evidence. These historical checks neither refresh provider readiness nor authorize a new provider session.

## Reproduce offline evidence

```sh
TRACK_B_NODE_MODULES=/absolute/path/to/node_modules \
  node tests/track-b/live-acceptance/offline/run.mjs \
  f0068733ca49c37f40fd7de279325f21a4b5fbbb
```

This calls the existing integration acceptance runner without copying/replacing its tests, stages contracts and actual composition from the specified local Git revision, checks strict TypeScript, and refuses skips/nonpassing tests. It uses fixture providers and PGlite; it makes no live-provider claim.

At Track B `eb285be3e13bbc34abf483e4819773b19f8448d2`, the first direct invocation passed TypeScript and 9/9 tests. The second invocation through the new wrapper passed historical evidence assertions and TypeScript but **failed 1/9 tests**. Both outputs are retained under `offline/`. The wrapper intentionally returns nonzero. No retries hide the failure.

The failure is A5's `progress.phases[0]?.outcomes` assertion at `tests/track-b/integration-acceptance/acceptance.test.ts:228`. Projection sorts phases by HMAC evidence reference (`packages/core/src/reporting/chat/projection/index.ts`), while the test assumes the run phase sorts first. With the fixed Calendar target, the investigation phase legitimately has empty outcomes and can sort first. The source comparison supports an ordering-dependent test defect; it is not evidence of a live Calendar failure. The integration-test owner should select the running phase or inspect all appropriate run outcomes. This workstream does not change that owner's files. Until repaired, this combined offline command is not a stable green acceptance gate.

## Inspected app/configuration boundary

The current checkout contains core code but no `apps/web`. Read-only inspection used locally available `origin/track-a` at `f0068733ca49c37f40fd7de279325f21a4b5fbbb`, including `.env.example`, `apps/web/src/server/services.ts`, `packages/core/src/integration/compose.ts`, and `integration/eval-services.ts`. No private env files or secret values were read.

Actual declared names include `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NAIVE_API_KEY`, `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, `NEON_AI_GATEWAY_URL`, `NEON_AI_GATEWAY_KEY`, `APP_URL`, `SESSION_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `BLOB_READ_WRITE_TOKEN`, and the `NEON_STORAGE_*` family. Agent runtime additionally requires `NAIVE_AGENT_COMMERCIAL`, `NAIVE_AGENT_EVALUATION_ENGINEER`, `NAIVE_AGENT_QUALITY_INVESTIGATOR`, `NAIVE_AGENT_COMPANY_OPERATOR`; these are absent from that example but present in code. Merely finding a declared name does not prove a credential is configured. No ambient secret-value presence probes were performed.

`EVAL_SERVICES` defaults to `mock`; `real` wraps Track B in `withLiteFallback`. The inspected composition explicitly refuses designSuite/runSuite/investigate/rerunFinding/proposeAndVerifyFix. Therefore neither a running app nor `EVAL_SERVICES=real` proves execution through the intended Track B rich services. The acceptance adapter must identify actual engine provenance and reject mock/lite fallback. Gateway names above are existing app configuration; acceptance target URL/model/reference names below are explicit harness inputs, not invented app environment requirements.

## AppWorkflow interface coordination

The AppWorkflow patch team owns `docs/workflow-integration/**` and app artifacts. This workstream does not modify them. The expected boundary is an authorized server adapter over durable storage, with explicit package/job/subject/target/suite/run identities, frozen original evidence, and exact dispatch provenance. It must expose bounded real Text and Calendar buggy/fixed execution, secured remediation trial receipts and ledger records, a process/service reconstruction boundary, and report/private-chat reads. It must never substitute mock/lite for unavailable Track B phases. The executable provider app contract records the precise export/input/output expected by this harness; the team should supply that adapter through the private configuration rather than embedding credentials or app-specific auth in tests.

Acceptance requires: the known buggy case yields objective product evidence and the fixed case passes the same immutable criteria; infrastructure/provider failures remain unresolved; remediation receipts match the actual dispatched prompt/model/payload, original suite/baseline/trial identity and durable accounting; reconstruction/replay adds zero target calls and zero duplicate costs; reports retain original and reproduced evidence; authorized private chat reads persisted opaque evidence, isolates subjects, and rejects revoked access. Core fixture tests, an adapter's assertions, or a declared service mode alone cannot establish these app gates.

## Ready provider commands and exact remaining inputs

The [provider interface and configuration contract](../tests/track-b/live-acceptance/provider/README.md) contains private-file examples and the exact `createAcceptanceDriver` export. Plan files are committed without credentials. A plan command reads no private reference and performs no provider calls:

```sh
node tests/track-b/live-acceptance/provider/run.mjs --plan
node tests/track-b/live-acceptance/provider/app-run.mjs --plan
```

Only after the parent's separate exact-run approval:

```sh
node tests/track-b/live-acceptance/provider/run.mjs --live --config /private/approved-text-acceptance.json
node tests/track-b/live-acceptance/provider/app-run.mjs --live --config /private/approved-app-acceptance.json
```

| Runner | Hard operation envelope | Required configuration and acceptance |
| --- | --- | --- |
| Direct Text | 4 target requests, 8 Gateway judgments; no retries, Naïve sessions or cloud mutations. Target completion limit 512/request, Gateway 2048/request: at most 18,432 requested output tokens across this run. | Unique run/evidence path; explicit buggy/fixed full HTTPS Chat Completions URLs and models; private token env/file references; Gateway model and token reference; installed compatible dependencies; exact approved counts. Executes S01/S09 from the unchanged twelve-scenario suite. Buggy must fail and fixed must pass all selected criteria through the actual secure transport/Gateway. This is a two-scenario probe, not full-twelve provider acceptance. |
| AppWorkflow adapter | At most 32 target requests, 16 Gateway judgments, 180s; zero Naïve sessions/cloud mutations. Completion limits 512/2048: at most 49,152 requested output tokens. | AppWorkflow-owned actual adapter module; opaque private runtime reference containing authorized app/database/auth/artifact/target configuration; unique run/evidence path; exact approved caps. At least two same-suite Calendar cases, remediation dispatch receipt/accounting, actual process restart, report persistence, and private chat authorization must pass the executable contract. No such actual adapter is present in the inspected artifacts, so app provider acceptance is **not run**. |

These are separate approval envelopes, not permission to run either or combine them. Provider price/model and input usage remain unknown; a monetary estimate would be fabricated. Select models and reconcile billing before approving spend. Token counts/unknown costs stay distinct from measured micro-USD. Neither script silently substitutes fixtures or refreshes the accepted paid design. Journals use exclusive creation, durable intent before dispatch and no automatic retry; an interrupted run requires parent reconciliation rather than a new ID to evade ambiguity.

## Local native SQL, TLS and secured-remediation evidence

```sh
node tests/track-b/live-acceptance/native/run.mjs \
  --harness /absolute/path/to/installed/track-b-harness \
  --track-a-ref f0068733ca49c37f40fd7de279325f21a4b5fbbb
```

The native runner installs a pinned PostgreSQL binary/runtime and TypeScript into disposable temporary storage, snapshots real source, stages actual contracts from the pinned local revision, and reuses `postgres-live/verify.mjs`, `postgres-live/checkpoints.mjs` and selected existing tests. It binds PostgreSQL to loopback, generates disposable local-only authentication, performs actual clean process restarts and deliberate backend termination, then removes the runtime. It does not apply cloud migrations or use a configured cloud database. It fails if a required runtime/test is missing or any selected test is skipped; connection diagnostics are scrubbed of generated authentication.

Local SQL results cover eight branch-ledger/pinned-transaction tests, four checkpoint-ownership/restart tests, and five new journal/private-chat recovery tests. Native locks are observed through distinct backend PIDs and `pg_blocking_pids`; durable pending intent remains visible before target dispatch and survives owner connection loss/process restart. The chat race checks immutable replay and subject/job separation. These prove native local PostgreSQL behavior, not app auth, production failover or live Calendar provider behavior.

The reused TLS tests use real local sockets/certificates, replacing only routing and the test trust root because production rejects loopback/non-443 targets. They exercise original Host/SNI, certificate identity/trust, byte/deadline/redirect/encoding checks. No public endpoint is contacted, and production policy is not loosened. Reused secured-remediation tests validate actual serialized requests, dispatch receipts and accounting against controlled responses; those are local adapter evidence, not remote application proof.

Final native command completed with exit 0: **17/17 actual native SQL checks** and **92/92 selected existing tests** (TLS 7, conversations 15 including all 3 native cases, accepted-v3 offline 16, secured-remediation target 31, remediation service 23). Zero skips/todos. Cleanup reports stopped=true and disposable directory removed=true. See [native results](../tests/track-b/live-acceptance/native/results.txt) and [runner details](../tests/track-b/live-acceptance/native/README.md). An earlier staging failure is retained separately; it was repaired in the harness without changing production tests. Native source transpilation is runtime verification, not an additional strict TypeScript claim.

Provider harness offline verification completed **20/20**, zero skips/todos: plan/live gate checks, private-reference handling, actual core-module imports, and rejection of incomplete/fallback/invalid app evidence. See [provider offline results](../tests/track-b/live-acceptance/provider/offline-results.txt). Strict TypeScript also passed in the separate reused integration runner, whose A5 ordering-dependent failure remains open as described above. None of these local results closes actual provider/application acceptance.
