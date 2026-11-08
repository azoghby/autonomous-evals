# Shared paid application budget adoption

This owner-applyable extension starts from the **full immutable autonomy-release-adoption stage**, which retains judged Track A `aa94505` plus the exact owner `875ceef` refresh and judged report fix. It does not change those historical artifacts, actual application files, manifests or migration registries in this checkout. `application.patch` applies to that reproduced prior adoption stage, not bare Track A or an arbitrary current app.

The previous core pin `e4686a8` predates the paid reservation helper. This extension explicitly includes the complete exact `packages/core/src/agents/autonomy/budget.ts` postimage from main `0f1fe3cb5c11eb20477eace00a0447a56e728bac`; its preimage and postimage are hashed in `APPLICATION.json`. No broad core refresh or silent mutation of the old pin occurs. The new caller source is in `source/`; the builder emits a differential patch and verifies it on a fresh prior stage, including every unchanged baseline byte.

Reproduce offline with the existing retained dependencies:

```sh
node docs/autonomy-paid-app-integration/build-artifact.mjs
AUTONOMY_NODE_MODULES=/tmp/sandbox-generation-deps.cBCEai/node_modules WORKFLOW_INSTALLED_WORKSPACE=/tmp/workflow-bootstrap.JpxCTM node tests/track-b/autonomy-paid-app-integration/run.mjs
```

Review the baseline and exact preimages before owner application. Reconcile already-present additions by byte identity; never remove newer owner source to force this patch. This artifact does not register startup, routes or cron.

The autonomous evaluation context must originate in the authenticated release closure from current canonical company/job/policy authority, the same SQL connection and guarded autonomous runner. It is never parsed from a request body. All paid reservations use the helper's job, role-period and company-root scopes in one SQL reservation; the supervisor envelope is not a second charge. Enabled autonomous calls must never construct a legacy runner or silently fall back to legacy budget accounting. Explicit legacy calls preserve existing behavior.

Stable operation identities and input digests fence target dispatch permanently in SQL. Unknown usage retains its authorized hold. Only authoritative keyed provider receipts may settle it and deliver costs transactionally; local IDs are not provider receipts. Recovery must reconcile an existing operation rather than minting a fresh attempt ID. Calendar's current `targetForScenario` interface lacks a run identity: autonomous Calendar execution explicitly refuses this unsupported lifecycle until the owner supplies a real durable identity contract. Legacy Calendar behavior remains available through explicit legacy use.

Owner migration integration is separate: review the additive `source/apps/web/src/server/autonomous-paid.sql` and integrate its stable migration identity and hash with the parent's migration artifact/registry. No constructor runs DDL; apply only through the owner runner, using server-only grants. The SQL table is a permanent dispatch fence, not a lease to expire or clear before retry.

No live providers, cloud operations, credentials, deployment or spend are authorized or performed. The prior accepted phase bounds and conditional release plan remain unchanged: conditional immediate completion is **77 target / 50 Gateway / 10 paid Naive operations**, approved ceilings **32 / 16 / 0**, 180 seconds and no cloud mutations. Release acceptance remains false. Offline PGlite serializes transactions and cannot establish independent-connection hosted PostgreSQL contention or atomic external-provider revocation.

## Current-main preservation check

The implementation checkout remains based on `0f1fe3c`; during work `origin/main` advanced to `e99f8c4ad1ec7051f98d925e7fad87a0c05b0d4d` (parent merge `27af220`). `node docs/autonomy-paid-app-integration/check-current.mjs` inventories exact current-main protected bytes and refuses any extension source path overlapping Track A sandbox engine/runtime/spec, Track B sandbox evaluations, application routes/assets or manifests. `CURRENT-PRESERVATION.json` records those hashes and the optional trusted `exec?(sql)` contract. The new A engine at `6909195` is a distinct source tree; this extension does not replace it with the historical B engine. The existing owner parameter-forwarding patch is still required: current A query drops params. This check establishes preservation boundaries, not application/build acceptance on current main; the parent owns those current-main checks and reconciliation of divergent application caller preimages.

Owner configuration supplies `paidPolicy(request)` (immutable job cap and target/judge worst-case holds) and receives the minted paid context as the fifth `evaluate` argument. Pass it to `createRichWorkflowServices` or `comparisonProduction`; do not reconstruct it from serialized input. Monitoring also requires the release-created monitor runner, adding the same tick scope to its single SQL reservation. `verifyPaidReceipt` must validate genuine target receipt evidence before context reconciliation; judge reconciliation retains its existing owner-authorized receipt gate.

Apply `autonomous-paid-authority.sql` **after** the original release-access migration. It adds the durable digest of the entire company policy and paid configuration to release bindings; a same-version policy/cap change after restart refuses. Existing NULL digest rows require explicit owner reauthorization/migration; bootstrap never backfills them silently. The target-fence migration `autonomous-paid.sql` requires the existing agent persistence reservation schema for operation, and does not alter legacy tables. Neither SQL file is automatically executed.

The final read-only inventory observed a further `origin/main` advance to `d892dd5ea2c70a3ad388f9ceea0b2462445ff7ba`: 243 protected files, zero extension overlap, optional trusted exec retained. The report pins this exact observation; it is not a claim about future moving heads.

Final verification: **113 tests passed, 0 failed/skipped**, plus 6 SQL security tests; strict test, full core and full app TypeScript, and the offline Next/Workflow build passed. All ten tested applied-source postimages match the patch inventory exactly. The patch passed fresh baseline check/apply and unchanged-byte preservation checks. Retained local fonts and preinstalled dependency caches were used; this is not a clean locked-install or current-main build claim. See `VERIFICATION.json` and the owned test evidence directory. No hosted acceptance is implied.
