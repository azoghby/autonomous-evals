# Typed factual-gap owner entry candidate

Candidate source only. This directory does not install an application route, start a Workflow, apply a migration, call a provider, contact an expert, or commit honoraria. The owner patch includes portable source/tests and exact hashes; application wiring remains separate. Its production consumer postimage depends on the operator candidate described below.

`postimages/apps/web/src/server/expert-data-plan.ts` is a proposed new private server file. It reuses the existing `expert_workflow.plans` and `expert_automation_*` tables from migrations 0024/0025 without changing them. Its `ProductionDataInput` extension retains the exact typed proposal, its digest, canonical intake digest, secured target version digest, environment and tenant inside the immutable plan input.

## Private API and prerequisites

The existing job Workflow’s design **step** must catch `TextFactualGapError` inside the same process, before Workflow error serialization, and call:

```ts
await installFactualGapExpertPlan({
  jobId, environment,
  taskId: ownerAssignedExpertTaskId,
  versionLabel: ownerAssignedDesignVersion,
  proposal: error.proposal,
  canonicalInputDigest: error.canonicalInputDigest,
});
```

Return a serializable, durably bound entry status to the Workflow; do not rely on custom Error fields surviving a step boundary. The Workflow must obtain task/version identifiers from trusted operation configuration. The error and proposal cannot choose an owner scope. There is no public route or customer-supplied tenant ID. After `installed` or `replayed`, reuse `advanceJobExpertData` and the existing expert text consumer/timer only with both guarded consumer postimages in this patch; installation itself does not establish ready data, qualification, independent review or permission to skip those consumers. Root integration must handle `prerequisite_blocked` without repeatedly invoking generic design or substituting lite.

The current schema provides no rule that automatically approves arbitrary model-proposed factual coverage. Therefore installation requires all of these existing canonical records:

- A real, active `text_eval` job in the exact environment, with authorized stored intake, absent reference and both exact digests matching the new design operation.
- An enabled owner-provisioned `expert_automation_scopes` row for the exact job/task/customer, whose `request_hash` equals `reviewDigest({task, topic})` for the deterministic candidate task. A trusted owner can use `deriveFactualGapPlan` against canonical stored facts to inspect/configure that exact scope. Calling the derivation helper is not approval.
- An enabled existing policy with the current $25/job and $50/day caps (0024 schema and the current owner authorizer require exact equality; lower caps need coordinated owner changes); existing true sharing consent on that exact scope. Missing consent remains missing.
- At least one active, unsuppressed expert with existing qualification evidence, consent receipt and allowed evaluation use for the configured topic. No qualification or review is created. Current `source=opt_in` plus `consent_flags.contactForPaidWork=true` produces `contactGate: opted_in`; a qualified cold-only pool produces `contactGate: cold_approval_required`. Either may install an exact owner-authorized plan. This gate is advisory current contact status, never a send approval: existing discovery creates the approval-gated cold draft, and the existing owner rechecks approval before promises/sends.

Missing prerequisites return a typed `prerequisite_blocked` result. No scope, policy, qualification, consent or plan is created in those cases. Neither schema nor this bridge supplies an automatic owner validation policy; a product configuration/approval surface remains separate work.

## Identity, replay and transaction

The task covers each exact rejected check and question with one required independently reviewed case. Its identity includes the complete proposal digest, canonical intake/target, tenant, environment and design version. It requests evaluation use only; initial sources/cases are empty, so unreviewed model content cannot become ground truth.

The bridge first reads canonical identity, rejects inline plaintext keys, expired credential retention and missing required credential slots, reconstructs the secured target with the existing intake credential helpers, then reloads job and credentials inside a transaction, taking locks on the job, credential row, configured scope, policy and qualifying expert rows. The target version hashes the secured target including credentials without retaining their values; rotation changes task authority and cannot reuse the old scope. The reusable `assertFactualGapPlanCurrent` guard rechecks that binding after installation, at production entry and every production `assertCurrent`, and in expert runtime `basic` (therefore every `authorized`/`current` check before target dispatch and binding creation). It validates strict entry metadata, the complete immutable input/digest/proposal, current canonical intake/customer/environment, reconstructed secured target, credential expiry/required slots, exact owner task/topic scope, enabled policy and sharing consent. Present but malformed factual metadata fails closed; plans without the metadata retain legacy behavior. The guard only reads and never stores credentials or creates authority. It verifies authority before the only write, an `INSERT ... ON CONFLICT DO NOTHING` into the existing immutable plans table. The deadline is canonical job creation plus seven days. Existing exact plans replay; changed input/topic/deadline conflicts; disabled plans stay disabled. Concurrent job-scoped entries serialize on the job row. Existing immutable triggers retain the plan body and metadata.

The bridge does not reserve money. Existing downstream expert promise reservations and independent contribution/data review continue to own those decisions. Existing source/answer review and suite freeze remain required before readiness.

## Base and operator dependency

The base is exact `35fbcab1b0035ffb447f3766ec43f4363a03c3fd`. Apply the reviewed `docs/naive-operator-current-integration` candidate first: this patch deliberately uses its `expert-data-production.ts` postimage (`d4097d3fa7c028472f51f6ee8290ed05f201f1476228994e945bda7589acb930`) as the production preimage. The resulting consumer preserves that candidate's authenticated review mutation/transaction hardening and adds the factual guard. It must not overwrite the operator candidate with the older actual-main production file. The runtime preimage remains actual base source and retains the H5 month-wide Jude cap and nonempty period fallback. External sibling imports use the existing `@/server` alias for portable tests; local factual helper imports remain relative.

`manifest.json` identifies each exact preimage/postimage and the operator dependency. `owner.patch` therefore requires the operator production preimage; it is not a standalone patch against unchanged main. Neither candidate is adopted here. After owner approval, verify operator adoption followed by this patch as one composed stage, retaining both review and binding protections.

## Validation

Run from repository root with installed dependencies:

```sh
npx vitest run --config docs/naive-factual-gap-entry-integration/tests/vitest.config.mjs
npx tsc -p docs/naive-factual-gap-entry-integration/tests/tsconfig.json --noEmit
```

The original eleven installation tests (the earlier independent receipt is historical) plus downstream binding tests use minimal supporting base-table fixtures and apply the exact current 0024/0025 migration SQL and exercise real SQL reads, locks, inserts, immutable triggers and conflicts. Provider/email/payment services are absent. Tests cover exact installation/replay; no requests/invitations/reviews; missing scope/policy/consent/qualifications; changed proposal/intake/environment/customer; transaction-time revocation; immutable conflicts and revoked replay; real-mode/deadline/secret refusals; qualification evidence/allowed-use/suppression checks; cold contact without sends; missing/expired/inline credentials; secured target binding and credential rotation; unsupported lower caps rejected by current schema.

Final verification passes **41 tests across two files, zero failures/skips**: the original eleven installation tests plus thirty downstream binding tests. They execute the candidate production/runtime consumers after installation and reject rotated, deleted or expired credentials and changed intake before provider, invitation, promise, review, data-operation, checkpoint or text-binding creation. A rotation between production authority checks is also blocked. Legacy metadata absence remains a no-op; malformed metadata, changed proposal/input, scope/policy/consent revocation and forged digest authority fail closed.

The portable TypeScript configuration includes all six source/test postimages. A separate coherent stage at `/tmp/naive-factual-gap-current-stage` verifies 1,184 baseline Git blob identities at exact `35fbcab`, applies the operator ten-file candidate and then this six-file patch, and verifies every final postimage. Next type generation (57 steps/four workflows) and full staged web TypeScript pass; all postimage hashes still match after generation. `assemble-stage.py` reproduces that stage from the pinned committed-blob inventory without Git archive or copying environment files. Run `node ../../node_modules/next/dist/bin/next typegen` from its `apps/web`, then `node node_modules/typescript/bin/tsc -p apps/web --noEmit` from its root.

`evidence/plan-entry.results.json` is the current 41-test receipt; the prior eleven-test receipt is retained as `evidence/plan-entry.install-only.historical.results.json`. `evidence/final-verification.json`, `composed-patch-application.json` and `BASELINE-PINS.json` retain the current scope and source checks. No full build was run for this artifact. This is not a whole application build, deployment, migration, live conformance result or end-to-end expert readiness receipt.
