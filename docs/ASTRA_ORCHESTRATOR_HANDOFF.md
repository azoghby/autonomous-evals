# Fresh Astra orchestrator handoff

Prepared for Alex at his explicit request. Read this instead of importing the multi-million-token chat. Repository state and the selected plan are authoritative; this file records boundaries and where to resume.

## Current source checkpoint (2026-11-08)

This handoff's detailed inventory below is historical. Read the later entries in `LEDGER.md` and `docs/naive-plan-progress.md` before acting on old “not implemented” statements. The latest fetched origin/main is `3bf7c41`, merged into `track-a` at `b659725`. This preserves Track A’s billing, Revenue tab, authentication and session-lock changes. The local `main` branch is older; use the fetched ref and merge evidence rather than assuming it is current. The latest supplied AGENTS instructions require commits on `track-a`.

- Approved accounting/expert source is adopted in `796b5cf`; approved 26-file expert text routing/contracts/schema source is adopted in `9eb9e4c`. Do not apply those historical patches again. Adoption receipts distinguish them from their immutable pre-adoption manifests.
- `9eb9e4c` passed complete locked-install [GitHub CI](https://github.com/azoghby/standard-evals/actions/runs/42466546567). Core independent proxy accounting recovery is actual source in `11d7ff2`, independently checked with 987 tests/68 files and strict types; its full hosted [CI passed](https://github.com/azoghby/standard-evals/actions/runs/42467560403).
- Current operator review/recovery candidate: `docs/naive-operator-current-integration` (10files;35focusedtests/types/build; preserves Revenue). Current generic text candidate: `docs/naive-generic-text-adoption-integration` (16files;3858tests/two skips/types/offline-font build), pinned to35fbcab with current core. The operator candidate retains its explicit7c61008 baseline; both have independent postimage verification. They remain unapplied; original slice artifacts are historical. No deployed feature claim.
- An isolated schema-only Neon staging branch, fresh role and database have been created using privately supplied credentials. See `docs/naive-staging-infrastructure-receipt.json`; all 27 application and four sidecar migrations were applied to the empty fresh staging database. Replay, operation immutability/rollback and two-connection task uniqueness checks passed. Production was not modified. The staging branch expires November 15, 2026.
- Current source including typed factual-gap and optional judge recovery core passes web TypeScript and 3,780 tests, with two documented skips. The new 0027/0028 migrations are source only and are not yet applied to isolated staging. Operator and generic text candidates are being revalidated against this merged baseline; their previous receipts do not certify changed upstream files.
- Actual optional judge attempt recovery requires new sidecar/application wiring and an attempt-aware drain; see `docs/naive-judge-undispatched-recovery.md`. Typed factual-gap core is opt-in for new design slots; its owner entry helper remains an unapplied candidate.
- Full roster attestation/provisioning, generic method routing adoption, real hosted acceptance and subsequent plan phases remain open. Source tests do not satisfy these gates.

## Assignment and governing plan

Continue implementing Track B of Standard Evals / autonomous-evals. **The user explicitly selected `docs/NAIVE_PLAN.md` as the source of truth** after it was pushed in `0c8342a`. Implement its full phase sequence; do not substitute the older autonomy-supervisor artifacts for this migration. Start with unfinished Phase 0, then all eval methods, company roles/coordinator/deployments, simulator/judge/media and approval integration. Deterministic pricing, authorization, payments, budgets, target transport, SQL graders and lifecycle controls stay code-owned.

Read in order:

1. `AGENTS.md`, `LEDGER.md`, `TRACKS.md` (ownership).
2. `docs/NAIVE_PLAN.md` (full roadmap, SDK capabilities, roles, phases, keys, acceptance gates).
3. `docs/naive-plan-progress.md` (implemented deltas and validation).
4. Relevant source before using older handoffs. Many docs are historical pinned patches, not mounted app code.

User preferences: use Codex subagents and delegate independent work; children may split larger tasks with disjoint ownership. Finish/integrate/review their work. ECC and all `ecc:` skills are **opt-in and currently not enabled**. For UI work first read `/Users/alexzoghby/.codex/DESIGN_STANDARDS.md`. User approved the exact pixel Scout bunny; no redesign needed.

## Repository and working method

- Root: `/Users/alexzoghby/Documents/ChatGPT/YC Hackathon 2`.
- Working branch: `track-a`; remote `https://github.com/azoghby/standard-evals.git`.
- Track A actively pushes to main. Fetch and inspect upstream before pushing; preserve its changes, never force push. Root owns commits/merges; subagents use disjoint files and report changes.
- Track B owns `packages/core/src/{agents,evals,judges,monitoring,reporting,simulator,targets}` and its docs/tests. Do not overwrite Track A application/platform/runtime/contracts/manifests. Deliver owner-applied app patches or coordinate the documented interface changes.
- User's unrelated `docs/customer-recruitment/` is untracked work: leave it alone.
- Fresh root npm ci succeeded at the f99d436 documentation checkpoint. Current-root typegen/web types and 3,584 tests passed with two documented skips; see naive-source-verification-20261108.json. Missing-executable statements and retained dependency guidance below are historical. The combined operator candidate also passed fresh-dependency types/build but remains unapplied pending source ownership approval.
- Git sometimes stalls on cloud-backed/dataless files even with free disk. A slow observation is not proof a process stopped. Inspect/poll the existing handle; no duplicate commits/pushes or deletion of other workers' locks/worktrees. Disk improved from about 4.4 GiB free to 14 GiB after user cleanup; recheck current space.
- Tool orchestration instructions from the new chat govern. Native subagents for same-provider work finishing in the turn; T3 delegation for separate-provider/background/worktree requirements. Don't create shell worktrees for children. Do not launch competing orchestrators against the same checkout.

## Current checkpoint history

Before the final handoff commit, relevant integrated checkpoints are:

- `5a56d05`: merged latest A chat/derived-suite work and pushed main.
- `b6646d4`: Naïve Phase 0 budget-zero safeguards and $0.30 default task caps.
- `bebcfb0`: tested owner-applied sandbox scenario replay Workflow artifact.
- `ca329d0`: imported the selected Naïve plan.
- `5cf5e67`: B durable whole-scenario dispatch/replay adapter.
- `e8e33c4`: bounded DNS-pinned UTF-8 public-document retrieval.
- `71435dc`: refreshed historical company/Scout artifact (not deployed or adopted).

The commit containing this handoff and the latest provisioning-attestation checkpoint supersede that list. Resolve HEAD and compare origin/main before proceeding; don't reset to an old pin.

## What is actually implemented vs activated

### Naïve Phase 0

- `evals/service-adapter.ts` now rejects `ctx.budgetMicroUsd === 0` before agent runner/reservation calls for qualify, auditTrace/auditTraceDetailed and agent-enabled renderReport. Safe `TrackBBlockedError('paused_budget')`.
- `operatorSummary:false` permits deterministic reports at zero budget without any agent call. Positive-budget completed replay still redelivers measured costs with stable idempotency keys; app sink must deduplicate.
- `agents/roles.ts`: qualify and outreachDraft defaults are $0.30. Explicit lower authorized qualification budgets remain lower. No monthly/global/job cap was raised; no live preflight claim.
- Existing `agents/provision.ts` verifies four legacy deny-tool agents and never edits/deletes existing agents. The exported `attestAgentConfiguration` now compares explicit tool-bearing configurations (tools, MCP, skills, handoffs/coordinator, model policy, instructions, budget and expected metadata) and is used by existing provisioning. Diagnostics contain static field paths only. It checks SDK-observed values; unknown fields stripped by SDK parsing are not observable. This helper does not provision the expanded roster.
- **Not yet implemented:** the plan's complete `scripts/naive-provision.ts` workflow for agents/skills/outcomes/vault credentials/paused deployments, the expanded company-role manifest, full method mapping and live Phase 0 exit gates.

### Existing B engines—reuse, don't rebuild

- Naïve SDK/session recovery: `agents/{naive-adapter,session-service,postgres-ports,roles,provision}.ts`.
- Trace Audit: `evals/trace/*`, `evals/service-adapter.ts`; exact citations, secret screening, safe findings.
- Text engine/persistence: `evals/text/*`, `evals/integration/*`.
- Remediation: `evals/remediation/*`, secured target adapter `targets/remediation.ts` and durable accounting. An old comment in `integration/compose.ts` says no remediation engine exists; that is stale relative to B implementation. The missing piece is app contract composition.
- Calendar: `simulator/*`, `evals/calendar-integration/*`.
- Sandbox: `evals/sandbox/{generation,execution,grading,integration,persistence,runtime-storage,runtime-composition,scenario-dispatch}` plus media/durable-engine modules. These have separate handoffs under `docs/track-b-sandbox-engine/`.
- Evaluation data acquisition/review: `evals/data/*` and integration handoffs. Preserve immutable review/provenance binding, independent factual checks and source permissions.
- Private progress projection/chat: `reporting/chat/*` and related reporting adapters.

`packages/core/src/integration/compose.ts` still leaves designSuite/runSuite/investigate/proposeAndVerifyFix/rerunFinding unavailable. Do not mistake extensive core tests for all 11 application methods running on Naïve. The plan's lite-fallback removal and real conformance are required.

### Current A app and chat

Latest A changes included `7807637`, `83231ec`, `8eacd56`:

- Real app now has `apps/web/src/components/eval-chat/*`, APIs under `/api/evals`, a `/evals` list and copilot panels on sandbox-run/audit pages.
- These are newer than the old `docs/current-company-main-adoption`/Scout/chat artifacts. Do not apply old patches blindly over the new chat. Current chat is not yet proven to use Naïve.
- Customer sign-in: `/signin?next=/sandbox/new` or `/signin?next=/evals`, email magic link; verifying it creates the customer account. Use a non-operator email to test customer view. Live domain documented as `https://standard-evals.vercel.app`; hosted auth/email/deploy state was not verified in this handoff.
- Company onboarding already uses `getSandboxService → createEngineSandboxService → workflowSandboxExecutor → sandboxSuiteWorkflow/sandboxRunWorkflow`. Preserve that path. Enabling the historical jobs-based CurrentOwnerLoader would create a competing evaluator/payment model.

### Replay patch status

- Core adapter `evals/sandbox/scenario-dispatch/index.ts`: detached frozen identity, strict full-result persistence, current authorization/secret checks, no redispatch for pending/ambiguous operations. Allows genuine nullable suite binding. Globally unique run IDs are required within its checkpoint store.
- `docs/scenario-workflow-integration/owner.patch`: six-file owner artifact pinned to `5cf5e67`; stores the result before app publication and propagates unresolved without finalize/fail/world teardown, including rejected step responses. Its owner factory deliberately remains unconfigured; applying it alone would block new runs.
- Passed 52 applied-source tests, app/core typechecks and offline Next/Workflow build (52 steps, three Workflows). Test compatibility edits are fully listed, not hidden/filtered.
- **Important:** newer A commits changed pipeline/workflow files after this patch's base. Reconcile those source changes before any owner adoption. No production activation is claimed.
- Separate remaining issues: atomic keyed cost settlement, immutable onboarding run-start identity, real authorization/secret/validator ports, preparation/reaping recovery, hosted contention and live receipts.

## Recommended next assignments

Keep the phase order from NAIVE_PLAN; start a few concrete, disjoint workers rather than resurrecting every historical task:

1. Provisioning/roles: full plan role/config manifest and SDK-0.12.3-compatible dry-run/create-missing CLI, strict existing-version attestation. Existing org CEO must not be changed. Deployments created paused; no live sends/session runs in provisioning. Validate idempotency and ambiguous-create recovery.
2. Method composition: map existing rich B engines into the real EvalServices contract with A-owned routing coordination, durable state, cost dedupe and no lite fallback in the acceptance path. Preserve objective vs rubric authority.
3. Independent tests/security: provisioning safety and exact config drift, task-token/MCP role/customer boundaries, output/citation/numeric validation, recovery and cost replay. Build repros and fix real findings, not endless characterization-only success counts.

As phases expand, follow plan-defined skills/outcomes/files/proxy/coordinator/board/long-lived sessions/approval gates. Verify SDK capabilities against installed types and official docs before implementation. SDK 0.12.3 is pinned in the existing harness; don't assume newer APIs.

## Keys, cloud operations and acceptance

No usable Naïve key is available from this chat. The earlier private card exposed a one-use reference, not a persistent retrievable key. A targeted check found no NAIVE key in current process or project env files; no secret values were printed. User offered to provide keys when needed.

When a runnable live path needs a key, use T3 `request_secret` directly (private card, delivery:file for a CLI or secretRef for supported tools). Never ask to paste it in chat or hardcode it. The plan requires rotating the hackathon-shared key. Key names and A/B responsibilities are in NAIVE_PLAN §6. Task-token/idle secrets are new setup, not preexisting values to invent. Do not copy historical chat credentials into files.

No live provider calls, messages, cloud migrations or deployment were performed by these recent changes. Plan Phase 0 specifies staging, real conformance and a bounded diagnostic; prepare the exact runnable operation and reconcile its budget with current authorization before running it. Older full acceptance plan (77 target/50 Gateway/10 paid Naïve operations) exceeded its approved 32/16/0 caps and remains unaccepted. Those old limits do not silently authorize the new full migration. Follow new plan phase-specific scope deliberately.

## Validation commands and evidence

Retained local dependencies (verify existence first):

- `/tmp/sandbox-generation-deps.cBCEai/node_modules` (SDK 0.12.3, ipaddr.js 2.5.0).
- `/tmp/workflow-bootstrap.JpxCTM/node_modules` (fallback packages).
- `/private/tmp/current-company-main-adoption-2df6782-final-20261107/node_modules` (app build cache).

```sh
node tests/track-b/run-checks.mjs --components agents,evals --track-a-ref HEAD \
  --dependency-dir /tmp/sandbox-generation-deps.cBCEai/node_modules \
  --dependency-fallback-dir /tmp/workflow-bootstrap.JpxCTM/node_modules

node tests/track-b/scenario-workflow-integration/run.mjs
node tests/track-b/scenario-workflow-integration/build.mjs
```

The latter runners stage their historical exact base and owner patch, not current main wholesale. Their results do not certify current hosted behavior. The shared B harness stages selected components plus pinned imported A blobs, requires strict types, and refuses skipped/todo/missing tests. Independent native PostgreSQL and live runners remain separate.

Recent evidence:

- Phase 0 initial agents/evals: 669 tests / 40 files / strict types, no skips.
- Provisioning attestation: 206 agents tests / nine files / strict types, including 33 new regressions, no skips.
- Core scenario nullable binding: 489 eval tests / strict types.
- Owner Workflow: 52 tests, six postimage hashes, full app/core typechecks and production build.
- Secure public text transport: 161 target tests / strict types.

Required root `npx --no-install tsc -p apps/web --noEmit` and `npm test` were attempted offline and failed because checkout executables are missing. Do not turn those into a pass. Restoring a correct locked dependency installation is useful, but inspect symlinks/caches and disk first; don't mutate shared caches used by other workers.

## Handoff finish conditions

This handoff is not a completion claim. Full Naïve migration, genuine consumer acceptance, staging/prod activation, provider accounting and the plan's parity/latency/dry-run gates remain open. The final narrowly assigned worker has finished. No further worker tasks are being launched for this handoff. Verify the handoff checkpoint is on origin/main before beginning new changes. The fresh orchestrator resumes from the latest repository and this plan, not from old temporary candidates.

Final parent checkpoint validation: strict combined agents/evals harness passed **702 tests across 41 files**, none skipped, against `5a56d05be5ecd6ce421e86996ac89d63a91a0efe`. All assigned worker results were collected; no handoff worker remains active.
