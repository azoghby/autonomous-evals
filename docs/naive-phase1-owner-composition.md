# Current Naïve Phase 1 owner composition

This handoff describes current source, not an applied patch or deployment. Track B's `evals/naive-services.ts` now constructs all five contract-compatible methods directly from the concrete design, run, investigation, remediation and rerun implementations. It has no lite fallback, no env-driven connection setup and no substitute runtime. All dependencies are required. Invalid/zero paid budgets stop before owner ports are called.

## Current application gap

`packages/core/src/integration/compose.ts` still installs five unavailable methods. `integration/eval-services.ts` only builds the four-role session runner, basic service adapter and branch services. `apps/web/src/server/services.ts` still wraps real services with `withLiteFallback`. Consequently neither the new aggregate nor the individual adapters are active in current app routing. The five-method factory is **core composition support**, not proof that five app methods now work.

Track A can construct `createNaiveMethodServices` in its real-service factory and use its five methods in place of the unavailable entries. It must first supply the real owner ports below; empty or in-memory ports are not acceptable activation defaults. Keep existing qualify/audit/report, secure target checks and branch lifecycle functions. Do not replace these with mock/lite implementations during acceptance. Wire per-method routing and branch routing independently as specified in NAIVE_PLAN.

## Required owner ports and persisted authority

| Surface | Exact current contract | Required owner implementation |
|---|---|---|
| Design | `NaiveDesignServiceDeps.authorize`, `.engine`, `.admission` | Authorize caller/job; read canonical intake and stable design slot; use real rich design engine; atomically retain the full approved suite plus input digest and genuine admission ID. Reject changed input under the same slot. `load` must return pending/rejected/approved accurately. |
| Run | `NaiveRunServiceDeps.resolve`, `.persistRun`, `.checkpoints`, `.runner` | Resolve retained approved suite, current customer/environment, canonical secured target and stable run identity. Persist complete rich run immutably, scoped to job/customer/environment/run/target version. Reauthorize at commit; never persist a target key in the artifact. |
| Investigation | `NaiveInvestigationServiceDeps` | Resolve the canonical retained rich baseline and suite; public Suite/RunResult are projections, not authority. Supply the same durable checkpoint store used for execution and persist the resulting investigation evidence. |
| Remediation | `RemediationDeps.resolve`, `.checkpoints`, `.runner` | Resolve actual stored confirmed finding, original frozen suite/run, failing checks, target binding and isolated trial. Receipt must demonstrate actual patch application; request prose cannot supply it. Historical trace-only work remains proposal-only when no isolated trial exists. |
| Rerun | `NaiveRerunServiceDeps` | Resolve canonical finding and original evidence with current permission, stable rerun identity and secured target. Store rich rerun/relabel evidence before returning the public finding. Never reconstruct a suite from the optional request scenario. |
| Accounting | `ServiceContext.recordCost` | Atomic keyed receipt settlement is adopted in app source at `796b5cf`. Apply/reconcile migration 0023 and verify mounted replay before activation; see `naive-cost-settlement-handoff.md`. |

`PostgresTextCheckpointStore` and `evals/integration/migrations/001-text-integration.sql` already implement operation checkpoints. `evals/naive-artifact-store.ts` now supplies concrete SQL admission and rich run/investigation persistence in that table, including immutable conflicts and approval-level revocation checks. Its owner callbacks must implement current caller authorization and deterministic admission policy using the supplied transaction. Canonical target resolution and the application cost sink remain owner responsibilities. Share consistent runner, checkpoint store, target-version policy and current authorization across the five dependencies; configuring different incompatible stores per adapter can make a projected suite unusable downstream.

## Rich assessment and provider requirements

The current `RunResult` is boolean-only. Complete objective runs can be projected without loss. Rubric, inconclusive and infrastructure states must remain rich artifacts and currently fail closed at the legacy projection boundary. Do not coerce them to pass/fail to make conformance green. Owner contract/callers must gain explicit rich assessment support for general Naïve text evaluation.

The current rich and public finding labels also lack a dismissed/resolved lifecycle state. A rerun can retain Ines's explicit relabel decision, but cannot publish a dismissal by pretending it is inconclusive. The adapter blocks that public projection with `needs_operator`; Track A must extend the finding lifecycle contract and its consumers before resolved-finding acceptance can pass. Do not count this as full rerun support merely because the factory exposes the method.

Injected rubric judges are not automatically Naïve. `judges/naive-proxy.ts` now supplies the plan's Jude proxy alternative with durable request fencing, exact-quote validation and SDK billing-trace reconciliation. `judges/naive-proxy-service.ts` now constructs it with the actual ServiceContext cost callback and validated `naive_proxy` receipts; operationId supplies canonical purpose. Wire this factory explicitly with `createNaiveProxyBudget` and the shared SQL ledger, and keep objective checks authoritative. It requires `proxy:write` and `audit:read`, a configured model/input-price policy, and an atomic `naive_proxy` cost sink. The SDK has no monetary cap for proxy calls; reservations are local admission bounds, not guaranteed provider ceilings. The factory does not certify outcomes, files or all roster roles merely by importing a module. Text adapters do not implement workflow or version-comparison package semantics; those need explicit mappings with retained authority and parity evidence.

## Historical implementation evidence

`docs/current-company-main-adoption/owner.patch` contains earlier canonical resolver, approved-suite and rich engine composition concepts (for example `createTextEvaluationServices` near the historical `sendText` block). It belongs to its pinned historical company/jobs architecture. Reuse only reviewed invariants such as reauthorizing before transport and retaining approved suite identity. Do not apply the old CurrentOwnerLoader/supervisor wholesale: current company onboarding already uses the sandbox Workflow, and a competing jobs evaluator/payment lifecycle would violate the selected plan.

## Adoption acceptance

Use actual owner SQL implementations and real application method routing. Exercise design → approved immutable suite → run → investigation → fix/retest, including restart/replay, current authorization revocation, changed target/secret, lost cost acknowledgement and conflicting artifact identities. Verify no additional provider operation after completed replay. Require session/request IDs and measured usage for every agentic role, no lite substitution, exact citations and objective/rubric separation. Then run real conformance with target execution and the per-package tests from NAIVE_PLAN. Keep migration, core test, provider and deployed receipts separate.
