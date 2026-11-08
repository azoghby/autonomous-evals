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
  "targetEvidence": { "kind": "external_target" },
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

## Application acceptance v2 and concrete driver

```sh
node tests/track-b/live-acceptance/provider/app-run.mjs --plan
node --test tests/track-b/live-acceptance/provider/app-run.test.mjs
```

The concrete adapter artifacts live under [app-acceptance-integration](../../../../docs/app-acceptance-integration/). They exercise real rich factory, SQL, accounting, private reporting and authenticated chat implementations offline. Offline injected transport/session fixtures never establish live acceptance. Existing reports and journals are retained unchanged.

`app-run.mjs` now requires `evidenceSchema:"app_acceptance/v2"`. The previous unversioned contract incorrectly bound a Text-only remediation receipt to Calendar runs. It is rejected without migration by relabeling. V2 requires **both** Calendar buggy/fixed SQL evidence for at least two reviewed scenarios from one preserved frozen suite, and separate complete frozen Text12 baseline/trial remediation evidence. Text-only success is never full application acceptance. Calendar model switching is version comparison, not proof of Calendar remediation.

The exact approved caps remain **target32, Gateway16, Naive0, cloudMutation0**, 512/2048 completion tokens, and180 seconds. Preflight derives full12 rubric calls from the unchanged admitted suite:24 target Text requests +8 Calendar target turns =32 target calls;24 rubric checks per Text run ×2 runs =**48 Gateway calls**, excluding any extra Calendar judgments. The controlled Calendar handoff at commit `687b508` establishes two target turns per scenario/version. Full execution therefore **fails operation planning before config/secret reads, adapter import, journal creation or dispatch**. The desired two-scenario minimum target32/Gateway48/Naive0/cloud0 excludes investigation reproductions and is not executable through the current factories. **Current composition requires proposed target77/Gateway48/Naive0/cloud0:** full12 Calendar scenarios ×2 turns ×2 versions =48 target turns plus4 Calendar reproduction turns; Text12 baseline +12 trial +1 confirmed reproduction =25 target requests. A Calendar subset API and same-job version transition binding preserving one frozen Calendar suite are missing; independently bound jobs have different job-bound suite hashes. `proposedCurrentCompositionCaps` records77/48 and drives cap fit. They are not approved or silently enabled.180-second feasibility is not established. Combined rich source currently supplies `judge:null`, explicitly leaving rubrics unassessed; reserved Gateway composition is another live gate. No cached provider result may substitute for fresh required execution.

When those gates receive explicit parent-reviewed implementation and operation authorization, the existing live entrypoint expects a private0600 bounded config with `adapterModule`, `runId`, `evidenceFile`, opaque `privateRuntimeRef`, and exact `approvedCaps`. `createAcceptanceDriver` receives run identity, AbortSignal, limits and durable `beforeDispatch`; it returns `source:'actual_app_provider',fallback:false` and `run()`. It must use real secure provider transports and actual application handlers, never lite services. Every provider dispatch awaits its durable intent, and evidence operation IDs must equal that entire metered set. The current cap must not be edited as part of a run to bypass this gate.

See [the v2 evidence schema](../../../../docs/app-acceptance-integration/evidence-schema.md) for exact executable fields. Both private persisted reports survive separate-process restart byte-identically, with no replayed provider work and durable cost deduplication. Unknown amount is `costMicroUsd:null,measured:false`; known zero is `0,true`. Owner chat/history, revocation, cross-customer, anonymous and report bearer checks remain mandatory. Real handler outputs must derive these assertions; undeployed auth must remain blocked rather than acquiring success flags.

Provenance explicitly distinguishes externally operated targets from hosted controlled fixtures. Controlled declarations require actual HTTPS origin, deployed revision and patch SHA-256, supplied by the deployment owner. No hosted URL is invented. Declarations are operator supplied and **never remote attestation**; a plausible Calendar tool transcript is not SQL execution proof. Actual SQL state/assertions are authoritative. Controlled Calendar exact prompt compatibility must be reviewed independently; an arbitrary changed remediation prompt is not admitted by its endpoint.

## Inspected actual deployment/config references

Read-only inspection used `git show origin/track-a:.env.example`, `apps/web/src/server/services.ts`, `packages/core/src/integration/eval-services.ts` and the local core code. Local checkout has no `apps/` deployment. `t3/workflow-integration-patches` has no executable `docs/workflow-integration` adapter at inspection time. Existing `docs/progress-chat-integration/server/files/apps/web/src/app/api/jobs/[jobId]/chat/route.ts` is a patch artifact, not evidence of a running route.

Actual names: `APP_URL` defaults `http://localhost:3000`; `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`; `DATABASE_URL` and `DATABASE_URL_UNPOOLED`; `EVAL_SERVICES` defaults **mock**. Even `EVAL_SERVICES=real` wraps Track B services with lite fallback, so mode alone cannot satisfy this strict adapter. Existing app real role refs are `NAIVE_AGENT_COMMERCIAL`, `NAIVE_AGENT_EVALUATION_ENGINEER`, `NAIVE_AGENT_QUALITY_INVESTIGATOR`, `NAIVE_AGENT_COMPANY_OPERATOR` (`id@version`); no live role calls are required here. Branch production config names exist (`NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_SIM_SEED_BRANCH_ID`) but this brief does not authorize their use. Private storage config exists (`BLOB_READ_WRITE_TOKEN` or `NEON_STORAGE_*`); acceptance should use app-owned local private storage rather than provisioning those services. Only names and public example metadata were inspected; no secret values were read.

## Offline verification performed

```sh
ACCEPTANCE_DEPENDENCIES=/tmp/track-b-harness/node_modules node --test tests/track-b/live-acceptance/provider/*.test.mjs
```

Uses installed TypeScript5.9.3, Zod and ipaddr.js. `stage-core.mjs` transpiles actual checked-out source to a disposable temp directory; the source-import test verifies admitted suite digest and loads all direct runtime entry points without network. This is runtime import verification, not a replacement for the repository strict typecheck. **Historical offline suite results are retained; current v2 contract verification is documented under app-acceptance-integration.**, including refusal of missing live flag, permissive credential file, fallback/fixture evidence, inconclusive Calendar, different suite, same-process restart, duplicate dispatch, lost receipt, changed report and chat disclosure. No secrets or external providers are exercised by these tests.

Target evidence is now mandatory before secret resolution. For controlled fixtures use
`kind: "controlled_fixture"` with full `deploymentRevision` (40 hex) and
`patchSha256` (64 hex). Journals and terminal summaries label this
`controlled_fixture_text_only`; other targets use `external_target_text_only`.
These declarations are operator-supplied provenance, not remote attestation or
proof of customer model behavior. Existing journals are never rewritten.
