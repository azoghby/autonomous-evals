# Chat, build, packaging and controlled Text composition

`applyChat(stage)` in [apply.mjs](apply.mjs) accepts only a disposable assembled
source directory. It applies each historical patch with `git apply --check`
before application and refuses context drift with the exact failing artifact.
It never installs dependencies, resolves credentials, runs SQL or opens a service.
The parent final stager pins all `inputPaths` before calling it.

Application order is history/revocation correction; webpack/ESM/Tailwind
compatibility; source import and transport typing correction; benchmark-address
refusal; reviewed direct dependency/lock declarations; controlled Text routes.
The historical `0002` data-production import hunk is excluded because its context
predates the bridge's additional data-safety import. Its two directory imports are
corrected with exact single-occurrence checks after patching. No other
`data-production.ts` source is replaced. The obsolete servercompat patch is not
replayed: the bridge already retains the hardened exported `buildAgentDeps`,
verified exact Naive role versions, durable budget period/idempotency namespace,
and canonical Workflow cost sink.

Source review confirms the restored chat correction clears private progress and
history cursors on revocation, blocks further polling while denied, and discards
stale send/poll responses using the access epoch. Existing stable retry message
IDs, history cursor validation and stale history-request guards remain. The UI
correction changes behavior only; there is no visual redesign. The Next correction
retains the installed Tailwind loader, webpack selection and `.js` to TypeScript
aliases. The transport corrections preserve IPv6 range refusal and explicitly
reject benchmark IPv4 `198.18.0.0/15`; no private-DNS/TLS policy is relaxed.

The packaging patch changes direct dependency records and the matching workspace
lock records only. It preserves the original root manifest. The controlled Text
patch adds exactly the independent internal buggy/fixed Chat Completions routes
and their stateless shared fixture. Both require the independent server-only
acceptance bearer configuration, reject generic probes and the wrong model,
limit exact accepted payloads, and retain private no-store errors. This is canned
Text fixture evidence only, with no Calendar capability, deployment or remote
attestation. The existing parent provider runner and its mandatory evidence
provenance declarations are not patched or copied by this module.

`writeMigrationManifest(stage)` runs after the pack and remediation source layers.
It renames `003-remediation.sql` to `004-workflow-remediation.sql` and
`003-workflow-packs.sql` to `005-workflow-packs.sql`, retaining
`003-workflow-data.sql`. A preexisting destination refuses rather than overwrites.
It writes `owner-migrations/manifest.json` with the precise application order,
full unique identities, SQL digests and transaction ownership, plus separately
identified SQL copies. The core conversation SQL is selected once and its
documentation duplicate is explicitly excluded. Calendar seed SQL is recorded
for a separate isolated database and is not included in the application batch.
This is an owner-review plan, not SQL execution or a replacement migration
registry. Retain the release-packaging same-engine/role catalog preflight,
durable exclusive migration lock, historical cost reconciliation and private
grants/session requirements before any separately authorized deployment.

The current B core overlay belongs to the parent stager. This module never
replays old Calendar/core overlay hunks. Controlled Calendar endpoints and
monitoring lifecycle/complete-artifact comparison remain separate owner extension
points. The older app-run acceptance contract that binds remediation to Calendar
is not used as proof of Text remediation and must not weaken the core's supported
Text remediation behavior.
