# Chat + structured progress + Workflow correction series

Owner-applied artifacts only. Production app/platform/contracts/manifests and the original integration docs are unchanged. ECC is disabled. No migrations, installations, remote services, secrets, spending, outreach, pushes or PRs are part of this work. Deployment acceptance remains false.

## Exact composition and reproduction

[SERIES.json](SERIES.json) pins Track A `f0068733ca49c37f40fd7de279325f21a4b5fbbb`, current core `48519bf16e04bce3397ceaeb8abea060d2636263`, Workflow artifact commit `5f513d1` and historical chat correction commit `d7cd083`. Every applied patch has a checked SHA-256. In a clean disposable archive, apply the combined chat patch, overlay those seven current core directories, then apply structured progress, Workflow service bootstrap, Workflow producers, the current-core server correction, restored history correction and restored Next compatibility correction in that order. The manifest is executable application order, not an instruction to replay these patches over an already integrated app.

```sh
node tests/track-b/chat-workflow-release/stage.mjs
node tests/track-b/chat-workflow-release/verify-series.mjs
node tests/track-b/chat-workflow-release/servercompat/run.mjs
```

Staging never installs dependencies or runs a service. It prints a retained temporary archive path. Each application invokes `git apply --check` before applying, without three-way guesses or forced conflict resolution. Integrity verification independently compares all 48 restored files with their actual Git blobs, verifies patch digests, and checks the original root manifest, root lockfile and core manifest remain byte-identical. The app manifest changes only through the explicit webpack script patch. [APPLICATION-RESULTS.json](APPLICATION-RESULTS.json) records the current run.

## What is corrected

The restored history correction clears conversation/progress cursors and pagination on revocation, blocks polling while access is denied, and uses an access epoch to discard stale poll/send responses after reauthorization. Existing private-text clearing, stale history-request guards and stable retry message IDs remain. The build correction selects webpack, maps Node ESM `.js` imports to TypeScript source and preserves Tailwind processing using the installed loader. Default `next dev` still uses Turbopack; use explicit `next dev --webpack` for this series.

The [server correction](servercompat/README.md) resolves the actual duplicate `buildAgentDeps` export conflict with data intake by retaining Workflow's verified directory and durable budget requirements. New data costs flow through the canonical Workflow cost writer rather than a separate job-row locking protocol. Do not also apply `docs/data-production-integration/intake/track-a.patch`; its new files are already adapted here. The authenticated review route records a review, not Workflow wakeup or model approval.

The complete `d7cd083` docs and tests are restored byte-for-byte under [restored](restored/chat-release-verification/README.md) and `tests/track-b/chat-workflow-release/restored/chat-release/`. [RESTORE.json](RESTORE.json) maps all paths and hashes. Those are historical evidence/source snapshots, not current verification results or standalone relocated runners: their original scripts retain original path references and some historical install commands. Use the current owned runners for offline reproduction; do not run the historical compatibility installer.

## Migration sequence and ownership

The precise schema paths, database routing, transaction requirements and historical-cost reconciliation are in [server migration order](servercompat/README.md#migration-order-for-the-deployment-owner). Sequence: application schema and agent persistence; conversation tables once; Text checkpoint integration; evaluation-data `001` then operations `002`; structured inventory; Workflow bindings/global cost keys after historical cost reconciliation; rich artifacts; branch ownership/investigation journals in app storage and Calendar schema only in isolated simulator storage. Prefixes repeat across schemas and do not form a global sort order. Stop incompatible writers before backfill; conflicting identities must abort rather than be deleted to enable replay. Existing tables need actual schema inspection and server-only grants. No SQL execution is claimed here.

## Current-core overlay limits

Overlaying current core preserves its later durable data, reviewed packs and retained comparison primitives, but deliberately retains Track A's DB, contracts and integration adapters. It is a test composition, not a complete core merge or a claim that all current exports are routed through the app. The Workflow producer patch additionally changes Calendar operation binding in current core; inspect that explicit diff when integrating. This pin excludes the parent's concurrent identity/citation/report fixes; those must be separately merged and checked against the resulting owner revision rather than replaced by this archive.

The rich driver still refuses data tasks until an authorized ready+frozen suite admission and inventory bridge exists. Appended packs remain refused (`REDTEAM_PACK=off` for frozen12); accepted and quarantined paid scope cannot be silently dropped. Remediation is not verified, monitoring/comparison dispatch is not fully composed, Gateway reservations/usage and full report cost completeness remain owner work. Unknown and pending states remain visible. No generated fixture establishes deployed authentication, PostgreSQL concurrency, Neon transport, real Workflow recovery, provider provenance or customer isolation. Owner acceptance still requires real session revocation, cross-user/operator/public denial, credential changes, migrations and authenticated running/delivered jobs.

## Evidence boundaries

Seven actual applied cost-helper tests and targeted strict server/Workflow/review-route TypeScript passed; the cost sink is mocked, so its real transaction concurrency is not established. [Server results](servercompat/RESULTS.json) record that scope. UI/build evidence is kept separately under `ui/`; historical screenshot/build claims under `restored/` describe their original pins only. No new screenshot is needed for these behavioral/configuration corrections without a visual change.
