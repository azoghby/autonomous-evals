# Owner-applied combined adoption candidate

This review artifact combines cost receipt settlement and the SQL expert owner against **eaf7f6967f0d227b9826232afa9c368a2464e1be**. Actual application source and production remain unchanged. Apply this artifact instead of applying its two predecessor patches separately.

`manifest.json` pins every preimage/postimage and `owner.patch` SHA-256. `postimages/` contains the complete resulting files. `build.py` merges the older cost artifact with the current owner base, retains current owner changes, adds the expert source, and assembles the patch. `expert-schema.ts.txt`, `0024_generated.sql`, and `0024_snapshot.json` retain the Drizzle-generated migration definitions. The 0023 and 0024 journal entries and snapshot chain are included; no manual migration bookkeeping is required. The 0024 SQL additionally preserves the immutable operation, promise, and response triggers which Drizzle cannot express.

The one Track B source prerequisite is `packages/core/src/evals/data/adapters/expert-response.ts`, pinned in `tests/track-b/expert-automation-integration/SUPPORT-PINS.json`. Its Track B source is committed at `80fdf4fca35ac5c71cbeb8414df7cd5125170230` (SHA-256 `62a873349913257fd76dfac1f10ec9328d065c54d698e3d053e1bdeae08cf80c`); that prerequisite must be present before adoption; the patch deliberately does not add it. Existing Track B implementation and persistence support at the pinned base are also required.

## Review and source adoption

From a clean checkout of the pinned commit with the prerequisite available:

```sh
node docs/expert-adoption-integration/validate.mjs
git apply --check docs/expert-adoption-integration/owner.patch
git apply docs/expert-adoption-integration/owner.patch
```

The validator archives the pinned source into a disposable directory, checks every preimage and support pin, checks/applies the patch, verifies every resulting file, and runs the SQL cost/expert suites and original owner outreach tests. Its dependency cache paths can be overridden by `EXPERT_OWNER_DEPS` and `EXPERT_OWNER_FALLBACK`. It does not apply migrations to an external database. `RESULTS.json` records the artifact hashes, stage, and results.

The original outreach tests include an explicit mock for the newly introduced SQL-managed boundary. Existing assertions are unchanged: ordinary drafts are outside a managed operation, and the mock returns no matching operation. The separate SQL tests exercise the real managed implementation. This adaptation is part of the patch, so normal owner tests do not require an out-of-band compatibility setup file.

## Activation is a separate owner operation

Source adoption provides callable SQL adapters, authenticated response binding helpers, managed draft approval integration, receipt settlement sinks, and complete migrations. It does **not** mount the automated expert step in Workflow, provision any enabled policy/scope/qualification grants, register response routes, authorize customer sharing, configure a transport, promise honoraria, or send messages. Those owner decisions and mounting steps remain necessary before real acquisition can run. No production activation or deployment is claimed.

Before enabling receipt settlement, inventory/reconcile historical unkeyed Naive receipts as required by migration 0023; the sink intentionally refuses ambiguous legacy matches. Use the owner's normal reviewed migration/deploy workflow only after source review. Never enable development auth links in production.

## Recorded validation

`RESULTS.json`: 52 cost/expert SQL tests (including 11 current-authority hardening regressions) and 8 original owner outreach tests passed with no skips; focused types and full core types passed; 15 applied postimages verified. A separate read-only review confirmed the snapshot/journal chain, all three immutable triggers, unchanged original assertions, and accurate activation boundaries. Drizzle generation against both application schema files reported no changes.

`VALIDATION.json`: Next typegen passed (53 steps, 4 workflows). Supplementary full web types and webpack production build passed (47 static pages). This is **not** an exact dependency build: declared `@vercel/analytics@2.1.0` was unavailable from the registry and the disposable validation cache used 1.6.1. Default Turbopack rejected dependencies symlinked outside the stage; webpack succeeded. No manifests or lockfiles were changed. Resolve the existing dependency availability issue and repeat the owner's normal exact-dependency build before production deployment.

## Current authority hardening

The combined owner transform in `harden-owner.py` additionally rejects cancelled, failed, delivered, budget-paused, and payment-review jobs at the SQL authority boundary. Scope and policy enablement are rechecked for each operation. `knownSecrets` accepts a static array or a synchronous/asynchronous callback; callbacks resolve afresh for current owner/store authority, immediately before dispatch, and after contribution retrieval before publication. Persisted invitation replay is checked against the current secret set. The callback can refresh canonical job credentials and deny revoked owner plans. A blocked dispatch keeps its durable claim for reconciliation and never retries transport automatically.

`hardening.test.ts` runs against the actual patched SQL owner in the disposable validator stage. It covers all five blocked states, scope/policy disablement on retained owner instances, credential rotation on persisted invitation replay, rotation after a send claim, unsafe contribution publication following rotation, and scope revocation while contributions are awaited. Historical predecessor artifacts remain unchanged.

## Source adoption in this session

Alex explicitly approved applying this reviewed 15-file patch to Track A app/database source. Parent applied it and verified all 15 actual source hashes against the manifest. This approval and source adoption do not apply migrations, provision policy grants, deploy, enable outreach or authorize spending. Root local commands still lack checkout executables; GitHub CI validates the committed adoption separately.

## Hosted source verification

The actual adopted source in `796b5cf` passed [complete GitHub CI](https://github.com/azoghby/standard-evals/actions/runs/42462597513): clean locked npm install, Next typegen, web/core types, unit tests and default production build. This supplies exact-dependency hosted build evidence beyond the earlier local supplementary webpack check. It does not apply a database migration or deploy the app.
