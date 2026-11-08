# Staging schema gap: preparation only

The parent orchestrator’s read-only database catalog receipt contains 79 tables across six schemas and 35 Drizzle journal receipts. **All 33 current base migration hashes are present.** Two extra historical receipts remain unidentified by the current journal: IDs 21 and 22, hashes `5747079638da11170536ed54ee64cfccb94c109b454e8473c207d6be2b4592e3` and `c70a4742dbb064ff59197c711f07c3cb0ad2b6ddcecab3ac330b751269e1795a`. Retain and reconcile them; do not replay or delete them.

The adjacent JSON binds the exact catalog receipt, schema plan and inspected runtime sources. This comparison made no external connection, read no credentials and authorizes no migration. Expected catalog was composed from exact SQL in a fresh isolated in-memory PGlite instance using `optionalApplication`.

Definitely missing application authorities include:

- `job_budget`: operations, cost links, model admission/bindings, Gateway turns/steps.
- `workflow_stage`: stages, children, progress, cancellation and design/run checkpoint ownership, including recovery columns/constraints.
- Existing chat conversation tables `public.reporting_chat_scopes` and `public.reporting_chat_exchanges`.
- `expert_sourcing`, plus `public.expert_automation_scopes.authority_kind` and its constraint.
- `naive_proxy_dispatch`, `remediation_accounting`, `naive_internal` and `naive_copilot`.
- Optional `accounting_reconciliation`, `sandbox_runtime_storage`, `company_autonomy` and `public.app_workflow_investigation_journals`.

Agent persistence, text integration, evaluation data task/operation storage and application branch ownership tables and introduced columns are present. Their canonical migration hashes, trigger/function bodies, indexes, grants, defaults/generated expressions and data compatibility are unverified. Existing sidecars must not be replayed blindly, particularly non-idempotent `CREATE SCHEMA`/`CREATE TABLE` files.

Against the complete optional application profile, 37 expected tables and 199 expected non-not-null constraint names are absent. Most missing constraints belong to missing tables; the missing constraint on an existing table is `expert_automation_scopes_authority_kind_check`. Shared existing columns show no observed type/nullability mismatch. There is one extra catalog table, `drizzle.__drizzle_migrations`, which the isolated raw-SQL composition intentionally does not create. PostgreSQL native not-null constraint rows were excluded from cross-version constraint-name comparison; no constraint-definition equivalence is claimed.

For a narrowly isolated qualification → audit → report trace path, the source-derived common schema prerequisite sequence is existing agent persistence, shared job budget, stage ownership, stage recovery, stage progress, cancellation, and design recovery. Six of those seven sidecars are structurally missing; agent persistence is present but unverified. Design recovery is necessary even on trace because the current stage INSERT always names `expected_child_plan`. Existing mock/lite trace paths also use this common authority. Real Naïve model admission adds model envelopes, yielding seven missing sidecars. The JSON supplies exact canonical paths/hashes and ordered IDs. This reduced trace list was source-inspected, not separately executed as a reduced-profile acceptance test.

That narrow list excludes chat, text execution, remediation, proxy judges, experts, internal/copilot and branch capabilities. The application can still route to these features; this is therefore not a full-application deployment minimum or a delivered-job acceptance claim. Retained usage/cost evidence, authorization, provider configuration, grants, native contention/restart behavior and monetary holds require their own acceptance. SQL table presence and journal receipts cannot establish those properties.

Run/design recovery replace constraints. The runner now has independently reviewed exact-file/hash support and 24 passing focused tests; see `runner-validation.json`. This gap report neither changes the executor nor authorizes its use. All 33 existing base receipts and both extra historical receipts must be preserved while preparing any separately approved sidecar plan.
