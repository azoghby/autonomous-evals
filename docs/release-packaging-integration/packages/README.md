# Direct dependency packaging handoff

Pinned Track A: **da92bedd68b230188e2499fdd8440ea23b2f1d6b**. Track B
parent: **f8d1f75cf53422015e63b8ac3233eacbaa1a30d5**. No fetch occurred.
[manifest.json](manifest.json) records the exact owner/version map;
[track-a-manifests-lock.patch](track-a-manifests-lock.patch) is the reviewable
owner patch. Actual owner manifests, application code and platform files remain
untouched in this checkout.

| Direct owner | Added production dependency | Exact existing lock version |
| --- | --- | --- |
| `packages/core` | `resend` | `6.37.0` |
| `packages/core` | `dotenv` | `18.0.9` |
| `apps/web` | `drizzle-orm` | `0.45.4` |
| `apps/web` | `zod` | `4.6.7` |
| `apps/web` | `stripe` | `23.1.0` |
| `apps/web` | `@neondatabase/serverless` | `1.2.0` |
| `apps/web` | `@x402/core` | `2.30.0` |

The patch changes exactly `packages/core/package.json`, `apps/web/package.json`
and the corresponding two workspace records in `package-lock.json`. All existing
tarball versions, URLs, integrity hashes and dependency flags remain unchanged.
These packages were already in the production lock graph, including dotenv.
Root declarations cannot satisfy core's direct ownership requirement, and core
declarations cannot satisfy web's. Stripe's current web imports are explicitly
type-only; using `dependencies` conservatively keeps it available when an owner
builds with development dependencies omitted. This does not claim a runtime
Stripe request. Core's `dotenv/config` site is the administration source
`email/setup-inboxes.ts`, exposed by core's wildcard exports; no email or
administration script is executed here.

## Apply and reproduce

In an owner checkout of the exact Track A pin:

```sh
git apply --check /absolute/path/to/docs/release-packaging-integration/packages/track-a-manifests-lock.patch
git apply /absolute/path/to/docs/release-packaging-integration/packages/track-a-manifests-lock.patch
```

From the Track B repository root:

```sh
node tests/track-b/release-packaging/packages/build-patch.mjs
node --test tests/track-b/release-packaging/packages/contract.test.mjs
sh tests/track-b/release-packaging/packages/run.sh
```

The first command deterministically regenerates only this directory's patch. The
second runs three small contract tests. The third acquires
`/tmp/track-b-release-heavy.lock` with `mkdir`, registers shell trap cleanup, and
serially runs heavy checks. A busy lock exits **75** without launching any heavy
process; retry when the other owner is finished. Never remove another child's
lock. npm runs with `--offline --ignore-scripts --no-audit --no-fund`; dependencies
are extracted solely from the local npm cache into disposable directories, with
no network installation, lifecycle scripts, providers or application execution.
No cache metadata refresh is required. Retained temporary stage paths and logs
are printed in the JSON result. Requires local Git, tar, Node and npm plus the
cached tarballs for the pinned lock. Existing cache availability is a verified
fact for this run, not a portability assumption.

The runner archives the exact Track A commit, checks/applies the actual patch,
checks owner/lock agreement and unchanged unrelated lock entries, then performs
real offline workspace `npm ci`. It builds two separate owner fixtures from only
their listed direct additions and the reachable closure of existing locked
dependencies/optional dependencies/peers (6 packages for core, 23 for web).
It does **not** link or copy sibling workspaces, root installations or the existing
tool cache into these fixtures. Negative controls verify that each actual
production import subpath is unresolved before installation. Fixture `npm ci`
then installs real cached tarballs; the seven package versions must match exactly.
Actual TypeScript bundler resolution and Node ESM export resolution must point
physically inside that fixture's own `node_modules`. Provider modules are resolved
without importing or executing them. Both workspace and fixture lockfiles must
remain byte-identical after installation.

## Evidence and integration boundaries

[evidence/result.json](evidence/result.json) separates verified facts, assumptions,
blockers and limits. `packagingAccepted` is scoped to this dependency artifact;
`releaseAccepted` remains false. Command logs and the three contract test results
are retained alongside the JSON. An initial fresh-metadata fixture experiment
failed offline because the cached resend registry metadata was absent even
though its locked tarball existed. The final runner uses locked dependency
closures and passes without that metadata; the initial failure is retained for
transparency, not reported as an unresolved blocker.

The historical [exports contract](../../track-b-release-contracts/exports/README.md)
audited Track A `8634ceb`; its strict runner intentionally refuses current ref
drift. We do not relabel that historical failure as current success. This runner
rescans the pinned current source's actual import sites for the seven package
groups and records the file, line and explicit type-only marker. It verifies
module availability; it does not replace all public export gates or a semantic
application typecheck.

The three package inputs are byte-identical to the existing Workflow/data pin
`f0068733ca49c37f40fd7de279325f21a4b5fbbb`; this compatibility fact is asserted
against Git objects. The existing Workflow, chat and data patches are not copied,
modified, applied by this harness, or claimed as tested in combination here.
This manifest/lock artifact supplies their missing package declarations without
duplicating any source, migration, webpack, Tailwind or Workflow patch.

No unresolved blocker remains for this **scoped packaging check** on the recorded
local cache. Full integration still requires the owner to select/integrate the
existing source artifacts, apply normal migrations, and pass the final combined
Next/Workflow build and semantic typecheck. This run disables install scripts and
does not prove lifecycle-dependent native modules or a production build. The
existing chat/data/Workflow documentation retains its real authentication,
database, provider, budget, inventory and reconciliation release obligations.
No configuration, credentials, provider/cloud calls, deployments, push or PR were
attempted. A later Track A revision or unavailable local cache requires a rerun;
neither is silently accepted.
