# Bounded provider and application acceptance

No provider call was made to develop or test these scripts. `run.test.mjs` and `app-run.test.mjs` are offline harness/contract tests. Their green results do not establish live provider or app acceptance. `--plan` reads the existing accepted artifact and prints names/caps only; it reads no secret references and imports no app adapter.

The accepted Text design remains the original 12 scenarios, digest `0e5d6df16cd4c5953bb3a0966cf410216690549d3393cf60150d30b711a942e9`, measured design/review cost **129924 micro-USD**. The separate four-role exact-version verification is already `verified` in `tests/track-b/live-evidence/naive-configuration-verification-2026-11-07.json`. Neither runner provisions, inspects or starts a Naive agent. No paid design is repeated.

## Direct actual Text target + Gateway

```sh
node tests/track-b/live-acceptance/provider/run.mjs --plan
node tests/track-b/live-acceptance/provider/run.mjs --live --config /private/approved-text-acceptance.json
```

Parent must authorize that exact second command and its caps. Config file must be a private regular file (0600), at most16KiB; example shape (do not commit the filled file):

```json
{
  "runId": "parent_approved_unique_run",
  "dependenciesDirectory": "/tmp/track-b-harness/node_modules",
  "evidenceFile": "/private/unique-text-run.jsonl",
  "approvedTargetCalls": 4,
  "approvedGatewayCalls": 8,
  "buggy": {"url": "https://approved-target.example/v1/chat/completions", "model": "approved-buggy-model", "tokenRef": {"env": "BUGGY_TARGET_API_KEY"}},
  "fixed": {"url": "https://approved-target.example/v1/chat/completions", "model": "approved-fixed-model", "tokenRef": {"file": "/private/fixed-target-token"}},
  "gateway": {"model": "parent-approved-explicit-model", "tokenRef": {"env": "AI_GATEWAY_API_KEY"}}
}
```

The target reference env names above are harness examples, **not discovered app configuration**. Token refs accept exactly one `{env: NAME}` or `{file: PATH}`. File refs are0600, bounded and single-line; values are never printed. Config and credentials are resolved only after `--live` and exact approved operation counts. Existing journal files are refused (exclusive create), so an ambiguous run cannot be silently retried. Keep the journal on durable private storage; reconcile unfinished intent before any new run identifier.

Calls use actual `createTextTarget` -> `HttpsJsonTransport`, default public DNS pinning/TLS identity checks, no injected mock fetch/transport. Each version executes **S01 and S09 from the unchanged accepted suite**, followed by actual `createGatewayJudge` rubric judgments. Frozen system prompt remains authoritative. Buggy/fixed differences must be in the authorized target versions, not changes to the suite. No connectivity probe adds hidden calls. Caps: **4 target calls ×512 completion tokens;8 Gateway calls ×2048 completion tokens;0 automatic retries,0 Naive sessions,0 cloud mutations**. At most12 serial requests with each core request deadline30s; target rejects nonpublic endpoints. Input sizes are bounded by accepted suite and core adapters. Dollar cost is unknown; token counts are not a measured price or dollar cap. Parent must approve the explicit model pricing/provider spend limit separately.

Acceptance: buggy has at least one objective `fail`; both fixed executions are `pass` with no rubric gap; exactly4 target and8 Gateway dispatch intents exist, each unique; every Gateway usage record is persisted, including unknown/malformed usage. An error/inconclusive/unknown amount never becomes a pass or measured cost. Private evidence logs only ids/statuses and Gateway usage, not raw target responses/prompts/endpoints/tokens. This direct runner establishes Text provider behavior only, not application persistence, Calendar, report or chat acceptance.

## AppWorkflow-owned actual adapter interface

```sh
node tests/track-b/live-acceptance/provider/app-run.mjs --plan
node tests/track-b/live-acceptance/provider/app-run.mjs --live --config /private/approved-app-acceptance.json
```

Required private0600 config:

```json
{
  "adapterModule": "/absolute/app-workflow-owned/acceptance-adapter.mjs",
  "runId": "parent_approved_app_run",
  "evidenceFile": "/private/unique-app-run.jsonl",
  "privateRuntimeRef": {"file": "/private/app-runtime-reference.json"},
  "approvedCaps": {"target":32,"gateway":16,"naive":0,"cloudMutation":0}
}
```

`privateRuntimeRef` is opaque to the runner; the trusted **AppWorkflow patch team** resolves it. The team owns deployment/auth/database composition. The runner never guesses application routes, starts a server, runs migrations or reads the runtime file in plan mode. Adapter must export:

```js
export async function createAcceptanceDriver({
  runId, privateRuntimeRef, signal,
  limits, // target32, gateway16, naive0, cloudMutation0,
          // targetCompletionTokens512, gatewayCompletionTokens2048
  beforeDispatch, // await BEFORE EVERY provider operation; throws at cap/duplicate/deadline
}) {
  return {
    source: 'actual_app_provider', fallback: false,
    async run() { /* return the evidence shape below */ }
  };
}
```

This is a trusted integration adapter, not a claim that the app already exports it. It must wire real secure target and Gateway adapters and actual application SQL/artifact/conversation readers. **It may not import fixture services, use lite fallback, create cloud branches, invoke Naive design, send outreach or bypass `beforeDispatch`.** The cap is enforceable on cooperating adapter dispatches; arbitrary code could bypass a callback. Parent reviews this adapter before approving a live run. AbortSignal is mandatory for all work, including local subprocesses; adapter must terminate its subprocesses at the180s deadline and use only precreated disposable local storage. The runner also stops waiting after180s. Actual provider settlement beyond timeout remains unknown and requires reconciliation.

Expected application sequence: run at least2 reviewed Calendar scenarios against buggy and fixed versions on the same frozen suite; reproduce objective state failure and verified repair; persist stable remediation receipt/operation accounting; stop and restart the worker process; reload receipt and private report without replaying provider calls; read private chat as owner and attempt other-customer/anonymous/report-token reads. Do not submit payment, email notifications, PR creation or cloud mutations. A permitted fixture *job identity* may isolate internal acceptance from customer/revenue accounting, but target/judge traffic must be actual provider traffic.

`run()` returns exactly the following semantic evidence (extra internal fields remain app-owned). `validateEvidence` is executable and rejects unmet criteria:

- `source:'actual_app_provider', fallback:false`.
- `calendar:{suiteDigest,buggy:{runId,suiteDigest,productFailures:positive,inconclusive:0},fixed:{runId,suiteDigest,productFailures:0,inconclusive:0,passed:atLeast2}}`; digests match.
- `remediation:{receiptId,operationId,targetVersionBefore,targetVersionAfter,beforeFailed:positive,afterFailed:0,afterPassed:positive,regressions:0,dispatchedPayloadDigest:sha256,suiteDigest,baselineRunId,trialRunId}`; target versions differ; baseline/trial ids match their Calendar runs and frozen suite. Hash the actual dispatched prompt/model/payload, not just the proposed patch.
- `accounting:{operationIds:[uniqueIdsIncludingRemediation],unknownCostExplicit:true,duplicateDispatches:0,duplicateCostRowsAfterRestart:0,costRows:[{operationId,costMicroUsd:nullOrMeasuredInteger,measured:boolean}]}`. Cost rows cover each operation exactly once, and operation IDs exactly equal the metered dispatch set. Every listed ID has a prior durable `beforeDispatch` intent. Preserve provider usage/unknown accounting in app storage; never invent micro-USD.
- `restart:{processBefore,processAfter,replayedDispatches:0,persistedReceiptId}`; process identities differ and receipt matches. Reconstructing an object in the same process is not restart evidence.
- `report:{beforeDigest:sha256,afterDigest:theSameDigest,suiteDigest,receiptId,private:true}`. Digests are computed from persisted private report bytes before/after restart.
- `privateChat:{ownerRead:true,ownerHistoryPersisted:true,revokedOwnerStatus:404,otherCustomerStatus:404,anonymousStatus:401,reportTokenStatus:401,sharedArtifactContainsChat:false}`. Use real handlers/auth with distinct principals and report bearer. The adapter must retain private raw assertions, not merely set flags.

Runner requires at least one metered target and Gateway dispatch, records private durable intent before dispatch, refuses duplicate IDs/cap excess and writes only counts plus a SHA256 digest of detailed app-owned evidence on success. Failed runs keep intent with `failed_or_ambiguous`; no redispatch. Full acceptance is **not run** until this actual adapter exists and parent authorizes it.

## Inspected actual deployment/config references

Read-only inspection used `git show origin/track-a:.env.example`, `apps/web/src/server/services.ts`, `packages/core/src/integration/eval-services.ts` and the local core code. Local checkout has no `apps/` deployment. `t3/workflow-integration-patches` has no executable `docs/workflow-integration` adapter at inspection time. Existing `docs/progress-chat-integration/server/files/apps/web/src/app/api/jobs/[jobId]/chat/route.ts` is a patch artifact, not evidence of a running route.

Actual names: `APP_URL` defaults `http://localhost:3000`; `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`; `DATABASE_URL` and `DATABASE_URL_UNPOOLED`; `EVAL_SERVICES` defaults **mock**. Even `EVAL_SERVICES=real` wraps Track B services with lite fallback, so mode alone cannot satisfy this strict adapter. Existing app real role refs are `NAIVE_AGENT_COMMERCIAL`, `NAIVE_AGENT_EVALUATION_ENGINEER`, `NAIVE_AGENT_QUALITY_INVESTIGATOR`, `NAIVE_AGENT_COMPANY_OPERATOR` (`id@version`); no live role calls are required here. Branch production config names exist (`NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_SIM_SEED_BRANCH_ID`) but this brief does not authorize their use. Private storage config exists (`BLOB_READ_WRITE_TOKEN` or `NEON_STORAGE_*`); acceptance should use app-owned local private storage rather than provisioning those services. Only names and public example metadata were inspected; no secret values were read.

## Offline verification performed

```sh
ACCEPTANCE_DEPENDENCIES=/tmp/track-b-harness/node_modules node --test tests/track-b/live-acceptance/provider/*.test.mjs
```

Uses installed TypeScript5.9.3, Zod and ipaddr.js. `stage-core.mjs` transpiles actual checked-out source to a disposable temp directory; the source-import test verifies admitted suite digest and loads all direct runtime entry points without network. This is runtime import verification, not a replacement for the repository strict typecheck. **20 tests passed,0 skipped/todo**, including refusal of missing live flag, permissive credential file, fallback/fixture evidence, inconclusive Calendar, different suite, same-process restart, duplicate dispatch, lost receipt, changed report and chat disclosure. No secrets or external providers are exercised by these tests.
