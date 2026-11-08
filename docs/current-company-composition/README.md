# Combined company integration

This composes the reviewed private chat mount, Calendar durable identity,
payment/startup bridge, and corrected baseline tests. It is an owner-applyable
integration candidate, not an application deployment. Actual Track A files are
unchanged by these artifacts.

The starting application is pinned to `039851736eabb94e85c2c111bbccc78374716275`.
Later main-branch app changes must be preserved when the owner adopts the
differential; do not overlay this historical candidate onto a newer checkout.

## Reproduce source

First create the reviewed mounted-chat candidate:

```sh
CHAT_PRIVACY_COMMIT=66c2c90d2404d54619e227a71ea650c8b51471a2 node docs/current-chat-mount/stage.mjs --out /absolute/empty/mounted
node docs/current-company-composition/stage.mjs --from /absolute/empty/mounted --out /absolute/empty/company
```

The second command checks the complete input inventory, applies Calendar,
baseline mock correction, combined test compatibility, and payment/startup in
order, then records all final source hashes. It additionally verifies that the
publication reauthorization patch survives Calendar's overlapping edit.
`CANDIDATE.json` records the reproduced 2,041-file candidate. Every recorded file
matched the source used by the parent verification.

The combined test patch updates explicit historical expectations: Calendar is
now supported with durable identity, missing application SQL refuses before any
target or legacy construction, and missing startup adapters use the current
error code. It adds separate missing-Workflow and revoked-paid-authority cases.
The existing data-acquisition refusal regression and all other assertions remain.
The inherited baseline exclusion is removed. No skips or expected failures were
used to obtain the passing combined result.

## Verification

`RESULTS.json`: strict transitive test/application TypeScript and **164 tests
passed**, zero failed/skipped, covering all selected company, release, paid-app,
current-app, payment/startup, and Calendar tests. Tests use local SQL and scripted
provider boundaries. The dependency staging selected installed ipaddr.js 2.5;
an older cached 1.9 declaration caused the earlier compiler failure. Shared
caches and production source were not changed to resolve that staging issue.

The parent also verified core production TypeScript, full application TypeScript,
and the combined Next/Workflow webpack production build. All 2,041 recorded
source hashes still matched after the build. The build used existing offline
dependencies and cached real font files; no production source or manifests changed.

Current-main adoption, hosted authorization, independent production SQL
contention/recovery, real provider billing evidence, and deployment remain unverified. Genuine owner adapters and exact migration/grant
adoption are still required. Unknown costs retain their holds; no live operation
budget has been raised. The approved Pixel Scout mascot is a separate pending
extension and is not included in this candidate.
