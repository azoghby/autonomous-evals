# Track B release packaging handoff

Parent base: `f8d1f75cf53422015e63b8ac3233eacbaa1a30d5`. This delivery contains
an applyable [manifest/lock patch](packages/track-a-manifests-lock.patch) and a
[canonical SQL manifest/preflight](migrations/README.md). All changes are confined
to this directory and `tests/track-b/release-packaging/`. ECC is disabled.
Application manifests, app/platform code and other teams' artifacts are untouched.

The package patch targets Track A `da92bedd68b230188e2499fdd8440ea23b2f1d6b`.
The SQL and existing Workflow series use `f0068733ca49c37f40fd7de279325f21a4b5fbbb`.
The integration checker verifies that both pins contain byte-identical package
inputs and all 15 application migration files. This is compatibility of those
inputs; it does not establish compatibility of every application source change.
No moving branch ref is substituted for either pin.

## Concrete owner review sequence

1. Review [exact versions and offline resolution evidence](packages/README.md).
   In the owner's selected checkout, first check then apply the package patch:

   ```sh
   git apply --check /absolute/path/to/docs/release-packaging-integration/packages/track-a-manifests-lock.patch
   git apply /absolute/path/to/docs/release-packaging-integration/packages/track-a-manifests-lock.patch
   ```

   It changes only core/web direct dependency declarations and their workspace
   lock records. No root hoisting workaround or new tarball versions are added.
   Application owners must review any difference from the recorded pin before
   application; successful patch context alone is insufficient compatibility proof.
2. Integrate the existing source deliverables through their owners. Reuse
   [Workflow's ordered series](../workflow-integration/SERIES.json),
   [data intake](../data-production-integration/intake/README.md), and
   [chat corrections](../chat-release-verification/app-ui/RESULTS.md).
   These are references, not another combined patch. Workflow/data bridge,
   remediation, pack and chat merge teams retain their separate patches and
   composition decisions. The existing Workflow staging overlay is test assembly,
   not a proposed replacement of the final owner's source tree.
3. Have the migration owner review the [deployment order](migrations/manifest.json)
   and [session/catalog contract](migrations/README.md). Select only core chat SQL;
   exclude the documentation copy from automatic migration discovery. Include
   agent, ledger, acquisition/data operations, checkpoint, chat, journal,
   inventory, Workflow binding/cost and rich-artifact SQL in that order. Keep
   simulator seed SQL in its separate database. Runner-owned SQL uses a pinned
   transaction per artifact; Workflow SQL owns its transactions and must execute
   on an idle dedicated connection. No cloud apply command is provided or run.
4. On the final composed owner revision, run full semantic app/core TypeScript
   and the reviewed Next/Workflow production build. These package and SQL proofs
   do not replace those checks. Then complete the existing owners' authenticated,
   database/session, provider, budget, restart and live acceptance gates.

## Reproduce local proofs

From the repository root, using existing dependency caches only:

```sh
node tests/track-b/release-packaging/check.mjs
node --test tests/track-b/release-packaging/packages/contract.test.mjs
sh tests/track-b/release-packaging/packages/run.sh
TRACK_B_SQL_NODE_MODULES=/tmp/track-b-harness/node_modules \
  sh tests/track-b/release-packaging/migrations/verify.sh
```

Run these commands sequentially. Both heavy wrappers acquire the same mkdir
lock `/tmp/track-b-release-heavy.lock`; exit 75 means busy with no heavy check
started. Do not remove another process's lock. The package runner uses offline
npm extraction with lifecycle scripts disabled. The SQL runner uses disposable
in-memory PGlite. Neither takes production credentials or deploys anything.

Recorded child proofs: three package contract tests; offline workspace `npm ci`
with 936 packages and unchanged lockfile; eight isolated direct-owner subpath
resolutions covering 66 source imports, with eight failing-before-install negative
controls; 12 SQL verification groups covering 14 managed application tables and
133 actual catalog constraints. See [package evidence](packages/evidence/result.json)
and [SQL evidence](migrations/RESULTS.txt). Integration evidence is recorded in
[RESULTS.txt](RESULTS.txt). These counts retain their distinct scopes.

## Precise remaining blockers

- **Final source composition and build:** no full combined release build/typecheck
  has been run by this package. Earlier chat corrected builds are separately
  pinned evidence. The historical exports/SQL strict reports remain historical
  failures; this delivery supplies fixes/contracts without rewriting their results.
- **Workflow/data bridge:** the existing [compatibility review](../workflow-integration/PARENT-COMPATIBILITY.md)
  records conflicting `buildAgentDeps` edits, a separate intake cost writer that
  must join the single Workflow cost identity sink, authorized suite admission,
  durable expected inventory and producer watermarks. Separate bridge owners
  must resolve and verify these on the final composition.
- **Pack/remediation scope:** base12 and appended `rt_*` execution, report,
  investigation, remediation and inventory semantics require the separate pack
  and remediation owners' accepted composition. This patch does not accept
  quarantined cases or relabel unknown accounting.
- **Deployment SQL/session/history:** owners must supply the durable migration
  registry and lock, trusted schema roles, pinned runtime search_path and sessions,
  grants, history/backfill reconciliation and exact same-engine/role catalog
  reference. PGlite proves local single-session SQL behavior; native concurrency,
  advisory locks and runtime transport acceptance remain owner gates. Existing
  native data-ledger evidence is narrower than acceptance of this whole batch.
- **Live application acceptance:** authenticated private chat/report access,
  provider and measured-cost dispatch, restart/lost-ack recovery, configured
  credential policy and the existing [Workflow acceptance checklist](../workflow-integration/DEPLOYMENT-ACCEPTANCE.md)
  remain unverified here. See also [chat release gates](../chat-release-verification/README.md)
  and [data obligations](../data-production-integration/README.md).

Scoped dependency packaging and local migration selection/preflight are ready
for review. `releaseAccepted` remains **false**. No provider/cloud calls, secrets,
spend, outreach, deployment, push or PR occurred.
