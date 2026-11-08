# Naïve plan implementation progress

Source of truth: `docs/NAIVE_PLAN.md`, introduced by upstream `0c8342a`, explicitly selected by the user. This tracker records implemented evidence; it does not mark proposals as production features. Track A retains application, deployment, auth, platform and migration ownership. Track B owns agent/evaluation implementation and documented integration artifacts.

## Phase 0

Implemented and checked locally:

- `createTrackBServices` refuses zero context budget before any agent runner/reservation for qualify, auditTrace/auditTraceDetailed and agent-enabled renderReport. The refusal is `TrackBBlockedError('paused_budget')` with a fixed safe message. Positive context values do not replace atomic ledger admission.
- Deterministic rendering with `operatorSummary:false` remains available at zero budget, with no agent calls. Positive-budget completed replay retains measured-cost delivery for the application's keyed deduplication sink.
- Default qualify and outreachDraft budgets are 300,000 micro-USD ($0.30). Explicit lower authorized qualify budgets remain lower; no global/job/monthly cap is raised. Existing task identities with different requested budgets remain subject to the runner's input-change reconciliation gate. This is a default configuration change, not proof of a provider quote floor.
- Strict TypeScript and 669 agents/evals tests across 40 files pass, none skipped. Seven new adapter budget/replay regressions plus commercial default/override coverage. Fakes/local SQL do not prove live Naïve acceptance.

Provisioning attestation checkpoint:

- Exported `attestAgentConfiguration` with explicit expected configuration, reused by existing four-role provisioning. Exact nested tool permissions/configuration, MCP, skills, handoffs/coordinator, model policy, instructions, budget and expected metadata checks; static safe diagnostic paths.
- Strict agents harness passes 206 tests across nine files, including 33 new regressions, none skipped. SDK 0.12.3 may strip unknown schema fields before this helper sees them; attestation certifies observed configuration only.

Still required before Phase 0 exit:

- Dry-run/create-missing provisioning CLI, expanded role manifest using the attestation helper and the full plan's skills/outcomes/vault/deployment resources (deployments paused).
- Fresh `NAIVE_API_KEY`, pinned role IDs/versions, owner-applied staging migrations, real conformance and bounded live role diagnostic.
- The checklist's production NO-GO items are not cleared by these unit tests. No live keys, provider operations, cloud migrations or deployment were performed.

## Subsequent phases

Phase 1: map all required eval methods to durable Naïve sessions without lite fallback, retaining deterministic execution/grading and citations. Phase 2: company coordinator, board, deployments, scoped MCP, approval bridge, multi-turn conversations and grounded chat. Phase 3: scenario/simulator/judge/media adapters with parity and latency/cost acceptance. Phase 4: approvals and narrative checks. Optional computers remain Phase 5.

The current company path already uses the sandbox Workflow; do not activate the historical jobs supervisor as a duplicate evaluator. The scenario replay owner artifact is independently tested but not activated and is not a substitute for the new Naïve plan.

## Commands and limits

```sh
node tests/track-b/run-checks.mjs --components agents,evals \
  --track-a-ref ca329d010ae6f330b757add92178a274f0477b95 \
  --dependency-dir /tmp/sandbox-generation-deps.cBCEai/node_modules \
  --dependency-fallback-dir /tmp/workflow-bootstrap.JpxCTM/node_modules
```

The command uses retained local dependencies, not a fresh install. Required current-root typecheck/test commands still cannot run without checkout TypeScript/Vitest executables. The separate Workflow artifact has its own exact-source full type/build evidence; that does not certify this whole migration or hosted app.

Final parent checkpoint validation: strict combined agents/evals harness passed **702 tests across 41 files**, none skipped, against `5a56d05be5ecd6ce421e86996ac89d63a91a0efe`. All assigned worker results were collected; no handoff worker remains active.
