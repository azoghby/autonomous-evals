# Cumulative runtime activation review

Reviewed actual source `fbedc75d1ede96e792a72119ac606d10ade41fe4` against `/tmp/naive-run-recovery-final-v2`, LEDGER, PLAN, TRACKS, NAIVE_PLAN, cost-settlement handoff and recovery artifact. Approved factual39 is already source; do not replay historical patches. This review supports source adoption separately from rollout. It does not establish production readiness or live migration/configuration state.

## Deployment blockers even with Naïve flags off

- `workflows/steps/common.ts:withBudget` unconditionally calls `executeWorkflowStage`; existing mock/lite qualification, trace, report and evaluation stages require shared-budget/stage SQL.
- `job-store.ts:publication` queries `workflow_stage.cancellations` outside active stages too. Existing state/progress/findings/remediation writes and associated customer/payment workflows therefore depend on cancellation SQL. Cancellation endpoints/reconciliation need it as well.
- `naive-text-execution-runtime.ts:resolveJobNaiveExecution` queries `text_integration.checkpoints` for nonmock text jobs before method flags. Lite text evaluation still needs text-integration SQL.
- Existing `eval-chat/service.ts` supplies `reserveGatewayTurn`; `eval-chat/job-budget.ts` requires `job_budget.gateway_turns`, operations, cost links and steps. Internal MCP disabled does not avoid this existing Gateway chat dependency. Gateway remains the chat provider; Naïve copilot dispatch is a separate explicit task surface.

Source adoption is reviewable without deployment. Deployment requires catalog/data inventory, historical receipt reconciliation, separately approved sidecar migration application and native/hosted acceptance. Flags off alone are insufficient.

## Runtime mounts and config

`services.ts:getEvalServices` retains mock default, explicit lite and real with unavailable-only lite fallback. `EVAL_NAIVE_METHODS` selects generic methods only in real mode. Generic design/run/investigate require durable selection; retained factual work holds on rollback. `evaluate.ts` mounts `recoverableGenericTextRunStage`, which constructs runSuite through `defaultNaiveBuilder`, preserving raw pending until stage persistence. Recovery accepts real generic text endpoint/default without a branch.

Paid activation needs existing database/encryption/provider setup, `NAIVE_API_KEY`, pinned role `NAIVE_AGENT_*` versions, `NAIVE_JUDGE_MODEL`, valid positive `NAIVE_JUDGE_RESERVATION_MICRO_USD` and `NAIVE_JUDGE_MAX_OUTPUT_TOKENS`, approved policies/consent/entitlements, and real/method selection. `NAIVE_BASE_URL` is optional; `NAIVE_BUDGET_PERIOD_ID` defaults monthly. `EVAL_NAIVE_FACTUAL_GAPS=1` separately enables factual behavior; `EVAL_REAL_BRANCHES` controls branch routing.

Internal MCP requires `NAIVE_INTERNAL_MCP_ENABLED=1`, exact `NAIVE_AGENT_COPILOT=id@version`, at least 32-byte `NAIVE_TASK_TOKEN_SECRET`, HTTPS root `APP_URL`, internal MCP/copilot SQL and task authorization. Nothing in this audit enables it.

`NAIVE_JUDGE_ATTEMPTS=1` opts new logical operations into v2; retained v1/v2 identities survive rollback. Runtime judge accounting drains before paid factory authorization; the operator accounting route remains authenticated. The narrowly trusted accounting dependency can reconcile already incurred exact receipts after evaluation revocation/cancellation, without session creation, entitlement, stage recovery or dispatch authority. It is not a global background reconciler or target billing reconciler. Explicit configured invocation can read provider audit data; this audit made no such invocation.

## SQL dependency order

Ordinary Drizzle migration/deploy does not apply docs SQL or core subsystem sidecars. Files present in source are not applied migration receipts. Inventory actual schema/data and reconcile historical costs/reservations before applying separately authorized SQL with failure-stop behavior.

Dependency-respecting order, after existing base Drizzle migrations including 0023 receipts, 0024 expert automation, 0025 expert workflow, 0026 expert text runtime and subsequent existing migrations:

1. Core `agents/persistence-migrations/001-agent-persistence.sql` and `evals/integration/migrations/001-text-integration.sql`; preserve existing conversation persistence prerequisite for chat/copilot.
2. `docs/naive-shared-budget-integration/sql/001-job-budget-authority.sql`, then `002-gateway-turn-budget.sql` for existing Gateway chat.
3. Stage ownership `001-workflow-stage-ownership.sql`; stage recovery `001-stage-recovery-profile.sql`, `002-stage-progress.sql`; cancellation `001-job-cancellation.sql` after stage ownership.
4. Design recovery `001-design-stage-recovery.sql`, `002-design-checkpoint-ownership.sql`; budget envelope `001-stage-model-envelopes.sql` after stage/shared authorities.
5. Core `judges/migrations/001-proxy-dispatch.sql`. The judge-attempt artifact includes an exact review copy, not a second distinct migration.
6. Run recovery `001-run-recovery.sql`, then `002-run-checkpoint-ownership.sql`, after inherited stage/design/text/judge sidecars. This dependency order is exercised by `naive-run-recovery-integration.test.ts`.
7. Sourcing authority after expert automation/workflow/text prerequisites; remediation accounting before owner runtime; internal MCP before copilot dispatch and activation. Unified SQL contains copies of sourcing/Drizzle files, not additional migrations.

Each abbreviated file above lives in its corresponding `docs/naive-*-integration/sql` directory. This is a dependency inventory, not an executable migration transaction or proof of applicability to live data. Validate constraints, grants, legacy rows, transaction rollback and lock ordering on native PostgreSQL. PGlite composition does not prove native contention or hosted restart behavior.

## Deliberate monetary completion blocker

A retained completed target response proves behavioral replay only. Target monetary commitments remain unknown. The composed recovery cases retain one run result, twelve total target calls, one v2 judge and pending parent/target holds. No fabricated zero receipt may settle this gap. The candidate deliberately cannot claim completed stage/run, report publication or delivered-job recovery while target money remains unknown. Independent judge accounting does not settle target money.

Full Phase 0/roster/strict conformance, pricing envelope, complete budget coverage, native/hosted crash/restart and real application acceptance remain open. Historical artifact test/type/build receipts are local candidate evidence, not deployment acceptance.

## Operations boundary

This worker performed local reads/searches and wrote this document only. No credentials read, database connected, SQL executed, provider/deployment API called, flags changed, outreach initiated or spend incurred. Earlier live operations in LEDGER belong to other work and do not activate this candidate. Integrator owns required checks, ledger and commit; this worker ran no tests/build.

## Independent SQL inventory cross-check

The inherited manifest contains 23 SQL review paths plus the two run-recovery SQL files. These include duplicate review copies and omit some foundational sidecars from that inherited list. The adoption inventory must distinguish canonical migration references, aliases and prerequisites; alphabetical listing is not migration order.

Local SHA-256 grouping confirmed these exact aliases:

- Actual core Drizzle 0024 equals expert-adoption postimage 0024 and unified SQL 0024.
- Actual core Drizzle 0025/0026 equal the text-adoption postimages and unified SQL 0025/0026 respectively.
- Core judge dispatch SQL equals judge-attempt review SQL.
- Core remediation accounting SQL equals remediation-owner review SQL.
- Sourcing-authority SQL equals unified sourcing SQL.

Agent persistence, text integration and conversation persistence must appear as prerequisite references even though the inherited SQL hash list does not enumerate them. Existing Drizzle journal migrations remain prerequisites, not new duplicate docs applications. Never execute every inventory path blindly: duplicate non-idempotent CREATE/ALTER files can fail or replay incompatible constraint changes. The chain explicitly requires stage ownership → stage recovery → design recovery → run recovery: run recovery drops `design_plan_shape`, a constraint created by design recovery, and replaces the expanded profile constraint. Checkpoint ownership additionally requires text integration, and run checkpoint triggers require cancellation authority. This audit inspected source and hashes only; it did not execute migrations.

Existing expert execution also references `evaluation_data_persistence.operations`; include core `evals/data/persistence-migrations/001-evaluation-data.sql` then `002-data-operations.sql` in the prerequisite inventory. Optional independent remediation reconciliation has its own `evals/remediation/accounting/reconciliation/001-reconciliation.sql` after remediation accounting. It is an opt-in owner capability, not a runtime DDL task or evidence that target monetary reconciliation is installed. Simulator investigation journals/branch ownership sidecars belong to separately enabled workflow/branch scope and must be inventoried before those paths are activated.

Final inventory verification: all **69** SQL paths match their recorded SHA-256; all alias references resolve to identical hashes; all **46** committed core SQL files are included. The inventory hash matches the manifest binding. `liveActions:false`, `applyMigrations:false`, and the explicit alphabetical-only/manual-order declaration are intact. No missing core SQL reference or alias mismatch was found. This static verification does not authorize or execute a migration; dependency/activation blockers above remain open.
