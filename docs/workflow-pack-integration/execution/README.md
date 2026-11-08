# Rich Workflow pack execution

Artifact ownership: only `docs/workflow-pack-integration/execution/**`. No production
files edited, provider/cloud calls, installation, secrets, spend, outreach, push,
PR, or children. ECC disabled.

## Base and patch order

Use Track A archive `f0068733ca49c37f40fd7de279325f21a4b5fbbb`. Apply the existing
progress-chat combined patch, then overlay the seven core source directories in
`docs/workflow-integration/SERIES.json` from
`48519bf16e04bce3397ceaeb8abea060d2636263`, retaining Track A contracts, DB,
integration, and **redteam** source. This core includes `c63a67a` (the staging
script checks ancestry). Apply in order:

1. `docs/structured-progress-integration/backend/structured-progress.patch`
2. `docs/workflow-integration/service-bootstrap/0001-rich-service-bindings.patch`
3. `docs/workflow-integration/workflow-producers/002-workflow-producers.patch`
4. `docs/workflow-pack-integration/projection/003-pack-projection.patch` from
   `010b68fc91b1974934af9b88cb5ff65fd20f781d`.
5. This directory's `003-pack-execution.patch`.

`node docs/workflow-pack-integration/execution/stage.mjs` checks and applies that
composition to a disposable archive. If the sibling artifact is not in this
checkout, the script reads it from that exact local commit. No fetch, shell
worktree, install or deployed migration. Existing core checkpoints and Workflow
migrations remain required; additionally deploy the patch's
`apps/web/migrations/003-workflow-packs.sql` through normal migration tooling.
The approval table remains private, with no customer grants.

## Exact execution and projection seams

```ts
executeWorkflowPack({
  jobId, environmentId: 'test' /* or live */, workflowRunId, agentId,
  baseSuite, // admitted FrozenTextSuite, exactly S01..S12
  baseRun,   // complete SuiteRun, or explicit null = unknown base
  selection: { authorizationId }, // only durable operator-record reference
}): Promise<PackRunEvidence>
```

This is an internal server export from `apps/web/src/server/workflow-packs.ts`,
not a customer API or agent tool. Workflow authority is checked against the
stored current job run, tenant, environment and canonical target binding.
`agentId` is caller metadata, not review authority and does not issue an agent
session. There are no judge/model approval calls in this adapter.

The adapter uses the existing `createTextTarget`, `PostgresTextCheckpointStore`,
`createSecuredTextPackRunner`, and `createPackExecutionService`. It executes and
then reconstructs through authenticated `service.report` before returning the
complete evidence. `workflowPackRunId(jobId)` is always
`pack:${jobId}:baseline`, independent of Workflow invocation. A fresh worker or
Workflow cannot evade an ambiguous/pending dispatch with a new ID. Manifest,
base run, target configuration, source rules or review changes conflict under
that identity. Configuration identity includes the existing canonical target
version (endpoint settings/revision and credential ciphertext rotation). Credentials
stay in secured closures. No additional target transport, grading engine or
checkpoint schema is introduced.

`workflow-pack-registry.ts` imports the actual pinned Track A library and grader.
`gradeRule` calls **gradeRedTeam with exactly one trusted source rule**; it retains
leading/anywhere, base64 and separator-obfuscation behavior. Only the two core
supported literal-response cases execute. Unsupported and unknown cases remain
in the manifest and evidence as quarantine, never pass. Source files are retained
from the pinned Track A archive, not loaded from intake/check specs.

The rich step passes the untouched base12 suite/run to this API. It never feeds
appended IDs to the base12 engine, investigator or remediation. Before its single
immutable private write it calls sibling `attachWorkflowPackEvidence(base, pack)`;
the resulting key is **appendedPack**, preserving all suite/run/investigation and
pack manifest/results separately. It uses sibling
`containsWorkflowPackArtifactSecret(evidence, knownSecrets)` and the original
report scanner. The sibling owns inventory/report/storage/download projections.
No edits here target `workflow-inventory.ts`, `rich-artifacts.ts` or `report.ts`.
Unknown/quarantined/incomplete pack evidence is retained before delivery stops
for operator review. An assessed pack failure stays visible independently of base12.

## Authenticated operator/source-rule contract

The added `/api/operator/jobs/[jobId]/workflow-pack` route uses the existing
`requireOperator` gate. No customer/model/intake record can approve itself.

With appended scope enabled (the default), the rich step first designs/retains
base12, then pauses before target execution if approval is absent. The operator
uses GET on this route to retrieve the completed retained design and base digest.
For POST, provide:

```json
{
  "action": "preview",
  "authorizationId": "operator-generated UUID",
  "baseDigest": "64-character retained base suite digest",
  "scenarioIds": ["rt_inj_direct_fake_system", "rt_inj_document"],
  "sourceRuleIds": ["authoritative-policy-record:v1"]
}
```

The operator must supply the **complete ordered selection** they authorize,
including unsupported IDs. This list is the pack's entire scope; it does not claim
the default Track A selector's complete twenty-case pack unless all twenty IDs
are supplied. The contract uses `draftFromAppendedInventory` with the actual
retained base12 and the complete supplied appended list; duplicates/overflow and
malformed inventory reject. No accepted-only filtering or stored executable specs.
The operator explicitly authorizes the source-rule references for this job and
actual target. These are references to the organization's authoritative policies,
not model suggestions; this endpoint's authenticated human decision issues their
job-specific authorization. It does not create upstream policy records or infer
authority merely from a digest/reference string.

Preview returns the exact draft, digest and complete accepted/quarantined trusted
inventory. After inspecting those plus the source policies, POST the identical
input with `action: "approve"` and `contentDigest` from preview. A changed target,
base, source rule or ordered case list changes the review digest. The receipt's
reviewer and timestamp are server-issued. Approval binds the actual retained
admitted suite. One immutable approval per job is persisted; another approval
returns 409. Retry approval after a lost response by reading its durable selection,
not creating another identity. `workflowPackSelection(jobId)` retrieves that
reference for the internal Workflow. Runtime authorization re-reads the private
row, reviewer receipt, source-rule list, tenant/environment/current Workflow and
actual target configuration. Setting `revoked_at` through authorized operator
maintenance denies subsequent execution/report resolution; no customer revoke API.

Resume the paused Workflow through the owner's existing authorized reconciliation
mechanism using the same job, designed suite and stable run identities. This
patch does not add an automatic wakeup service. `REDTEAM_PACK=off` retains the
explicit base12-only path. Calendar appended scope remains blocked. Pack
remediation needs a fresh authorized target/review and separately designed run
lifecycle; this baseline adapter cannot certify it. Immutable rich artifacts do
not support replacing an already retained unresolved snapshot after reconciliation;
that needs the owner's revision lifecycle, never a replacement dispatch identity.

## Offline verification

Run `node docs/workflow-pack-integration/execution/validate.mjs` with existing
`WORKFLOW_NODE_MODULES` (core/PGlite/Vitest) and `WORKFLOW_INSTALLED_WORKSPACE`
(complete pinned app dependencies). The harness stages exact patches, tests the
actual execution adapter, authenticated operator route, core SQL checkpoints,
actual pinned grader and rich step wiring. It then calls the existing complete
core/Next strict TypeScript and Workflow compilation harness, using installed
packages only. SQL tests use PGlite; the secured target is an in-process fake.
No providers, cloud or database deployments are tested. See `validation.log` for
the final run. Parent combined validation remains authoritative for sibling seams.

Final local run: **38/38 tests in five files passed**, none skipped. Complete core
and Next app strict TypeScript passed; actual Workflow tooling compiled **47
steps and one workflow** on the projection-before-execution composition.
